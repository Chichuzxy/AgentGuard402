// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPolicyRegistry {
    function policyAgent(uint256 id) external view returns (address);
    function policyToken(uint256 id) external view returns (address);
    function ownerOfPolicy(uint256 id) external view returns (address);
    function registered(uint256 id) external view returns (bool);
    function caps(uint256 id) external view returns (uint256 perTxCap, uint256 dailyCap);
    function check(uint256 id, address payee, uint256 amount) external view returns (bool ok, string memory reason);
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PolicyVault
/// @notice x402 结算的资金 + 策略执行层。
///         钱放在合约里, agent 手里不持币, 只有"按策略花钱的签名权"。
///         每一笔付款都先过 Registry 的规则, 再过每日额度/余额/重放检查,
///         任何一条不满足就整笔 revert —— 超限不是"日志里记一笔", 是链上拒绝。
///         预览用的 checkPayment() 与真正执行的 settle() 走同一份判断逻辑。
contract PolicyVault {
    struct PaymentIntent {
        uint256 policyId;
        address payee;
        uint256 amount;
        uint256 nonce;
        uint64 deadline;
        bytes32 resourceId; // 这份钱买的是什么资源(端点哈希), 用于审计
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "PaymentIntent(uint256 policyId,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 resourceId)"
    );
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    IPolicyRegistry public immutable registry;

    mapping(uint256 => uint256) public policyBalance;
    mapping(uint256 => uint256) public dailySpent;
    mapping(uint256 => uint256) public spendDay; // 最后一次记账的天序号
    mapping(uint256 => bool) public frozen;
    mapping(uint256 => mapping(uint256 => bool)) public nonceUsed;
    mapping(uint256 => uint256) public paymentCount;

    event Deposited(uint256 indexed policyId, address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed policyId, address indexed to, uint256 amount);
    event PolicyFrozen(uint256 indexed policyId, bool frozen);
    event PaymentSettled(
        uint256 indexed policyId,
        address indexed agent,
        address indexed payee,
        uint256 amount,
        uint256 nonce,
        bytes32 resourceId,
        uint256 spentToday
    );

    error UnknownPolicy();
    error NotPolicyOwner();
    error BadParams();

    constructor(address registry_) {
        registry = IPolicyRegistry(registry_);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AgentGuard402"), keccak256("1"), block.chainid, address(this))
        );
    }

    modifier onlyPolicyOwner(uint256 id) {
        if (!registry.registered(id)) revert UnknownPolicy();
        if (registry.ownerOfPolicy(id) != msg.sender) revert NotPolicyOwner();
        _;
    }

    // ---------- 出资方(owner)操作 ----------

    function deposit(uint256 policyId, uint256 amount) external onlyPolicyOwner(policyId) {
        if (amount == 0) revert BadParams();
        address token = registry.policyToken(policyId);
        require(IERC20Like(token).transferFrom(msg.sender, address(this), amount), "vault: deposit failed");
        policyBalance[policyId] += amount;
        emit Deposited(policyId, msg.sender, amount);
    }

    function withdraw(uint256 policyId, uint256 amount) external onlyPolicyOwner(policyId) {
        if (amount == 0 || amount > policyBalance[policyId]) revert BadParams();
        policyBalance[policyId] -= amount;
        address token = registry.policyToken(policyId);
        require(IERC20Like(token).transfer(msg.sender, amount), "vault: withdraw failed");
        emit Withdrawn(policyId, msg.sender, amount);
    }

    /// @notice 急停: 冻结后 agent 立刻一分钱也花不出去
    function setFrozen(uint256 policyId, bool value) external onlyPolicyOwner(policyId) {
        frozen[policyId] = value;
        emit PolicyFrozen(policyId, value);
    }

    // ---------- 付款校验 (预览与执行共用) ----------

    function hashIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.policyId,
                intent.payee,
                intent.amount,
                intent.nonce,
                intent.deadline,
                intent.resourceId
            )
        );
    }

    function hashTypedIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, hashIntent(intent)));
    }

    /// @notice 这笔付款能不能过? 不能过的话原因是什么 —— 与 settle 判定完全一致
    function checkPayment(PaymentIntent calldata intent, bytes calldata signature)
        public
        view
        returns (bool ok, string memory reason, uint256 remainingDaily, uint256 vaultBalance)
    {
        uint256 id = intent.policyId;
        vaultBalance = policyBalance[id];

        if (!registry.registered(id)) return (false, "registry: policy not found", 0, vaultBalance);
        if (frozen[id]) return (false, "vault: policy frozen", 0, vaultBalance);

        (bool ruleOk, string memory ruleReason) = registry.check(id, intent.payee, intent.amount);
        if (!ruleOk) return (false, ruleReason, 0, vaultBalance);

        if (block.timestamp > intent.deadline) return (false, "intent: expired", 0, vaultBalance);

        address agent = registry.policyAgent(id);
        if (signature.length != 65 || _recover(hashTypedIntent(intent), signature) != agent) {
            return (false, "intent: bad signature (not the authorized agent)", 0, vaultBalance);
        }
        if (nonceUsed[id][intent.nonce]) return (false, "vault: nonce already used", 0, vaultBalance);

        uint256 today = block.timestamp / 1 days;
        uint256 spent = spendDay[id] == today ? dailySpent[id] : 0;
        uint256 remaining = remainingDailyAllowance(id, spent);
        if (intent.amount > remaining) return (false, "vault: daily cap exceeded", remaining, vaultBalance);
        if (intent.amount > vaultBalance) {
            return (false, "vault: insufficient vault balance", remaining, vaultBalance);
        }
        return (true, "ok", remaining - intent.amount, vaultBalance);
    }

    /// @notice facilitator 结算: 校验签名 + 策略 + 额度, 打款给 payee, 落一条审计事件
    function settle(PaymentIntent calldata intent, bytes calldata signature) external returns (uint256 spentToday) {
        (bool ok, string memory reason,,) = checkPayment(intent, signature);
        require(ok, reason);

        uint256 id = intent.policyId;
        uint256 today = block.timestamp / 1 days;
        if (spendDay[id] != today) {
            spendDay[id] = today;
            dailySpent[id] = 0;
        }
        nonceUsed[id][intent.nonce] = true;
        dailySpent[id] += intent.amount;
        policyBalance[id] -= intent.amount;
        paymentCount[id] += 1;

        address token = registry.policyToken(id);
        require(IERC20Like(token).transfer(intent.payee, intent.amount), "vault: transfer failed");

        spentToday = dailySpent[id];
        emit PaymentSettled(id, registry.policyAgent(id), intent.payee, intent.amount, intent.nonce, intent.resourceId, spentToday);
    }

    // ---------- views ----------

    function remainingDailyAllowance(uint256 policyId, uint256 spentToday) public view returns (uint256) {
        (, uint256 dailyCap) = registry.caps(policyId);
        return dailyCap > spentToday ? dailyCap - spentToday : 0;
    }

    function spentToday(uint256 policyId) external view returns (uint256) {
        return spendDay[policyId] == block.timestamp / 1 days ? dailySpent[policyId] : 0;
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
