// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AgentPolicyRegistry
/// @notice 机器支付策略登记处: 谁(owner)允许哪个 agent、用哪种代币、
///         在多大额度与多长时间内、付给哪些收款人。
///         策略本身不碰钱, 只是"规则", 由 PolicyVault 在执行结算时强制校验。
///         任何 agent 项目都可以复用这个 Registry (公共品), 不必自己写额度逻辑。
contract AgentPolicyRegistry {
    struct Policy {
        address owner; // 出钱的人
        address agent; // 被授权的 agent 地址(用私钥对付款意图签名)
        address token; // 结算代币
        uint256 perTxCap; // 单笔上限
        uint256 dailyCap; // 每日上限
        uint64 validUntil; // 策略到期时间
        bool active;
    }

    uint256 public constant MAX_ALLOWLIST = 50;

    uint256 public nextPolicyId = 1;
    mapping(uint256 => Policy) private _policies;
    mapping(uint256 => address[]) private _allowlists;
    mapping(uint256 => bool) public registered;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed owner,
        address indexed agent,
        address token,
        uint256 perTxCap,
        uint256 dailyCap,
        uint64 validUntil
    );
    event PolicyUpdated(uint256 indexed policyId, uint256 perTxCap, uint256 dailyCap, uint64 validUntil);
    event AllowlistUpdated(uint256 indexed policyId, uint256 count);
    event AgentRotated(uint256 indexed policyId, address indexed newAgent);
    event PolicyActiveSet(uint256 indexed policyId, bool active);

    error UnknownPolicy();
    error NotPolicyOwner();
    error BadParams();
    error AllowlistTooLong();

    modifier onlyPolicyOwner(uint256 id) {
        if (!registered[id]) revert UnknownPolicy();
        if (_policies[id].owner != msg.sender) revert NotPolicyOwner();
        _;
    }

    function createPolicy(
        address agent,
        address token,
        uint256 perTxCap,
        uint256 dailyCap,
        uint64 validUntil,
        address[] calldata allowlist
    ) external returns (uint256 id) {
        if (agent == address(0) || token == address(0)) revert BadParams();
        if (perTxCap == 0 || dailyCap < perTxCap) revert BadParams();
        if (validUntil <= block.timestamp) revert BadParams();
        if (allowlist.length > MAX_ALLOWLIST) revert AllowlistTooLong();

        id = nextPolicyId++;
        _policies[id] = Policy({
            owner: msg.sender,
            agent: agent,
            token: token,
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            validUntil: validUntil,
            active: true
        });
        registered[id] = true;
        _setAllowlist(id, allowlist);

        emit PolicyCreated(id, msg.sender, agent, token, perTxCap, dailyCap, validUntil);
    }

    function updatePolicy(uint256 id, uint256 perTxCap, uint256 dailyCap, uint64 validUntil)
        external
        onlyPolicyOwner(id)
    {
        if (perTxCap == 0 || dailyCap < perTxCap) revert BadParams();
        if (validUntil <= block.timestamp) revert BadParams();
        Policy storage p = _policies[id];
        p.perTxCap = perTxCap;
        p.dailyCap = dailyCap;
        p.validUntil = validUntil;
        emit PolicyUpdated(id, perTxCap, dailyCap, validUntil);
    }

    function setAllowlist(uint256 id, address[] calldata allowlist) external onlyPolicyOwner(id) {
        if (allowlist.length > MAX_ALLOWLIST) revert AllowlistTooLong();
        _setAllowlist(id, allowlist);
    }

    function rotateAgent(uint256 id, address newAgent) external onlyPolicyOwner(id) {
        if (newAgent == address(0)) revert BadParams();
        _policies[id].agent = newAgent;
        emit AgentRotated(id, newAgent);
    }

    /// @notice 一键停用/恢复策略 (agent 立刻失效)
    function setActive(uint256 id, bool active) external onlyPolicyOwner(id) {
        _policies[id].active = active;
        emit PolicyActiveSet(id, active);
    }

    function _setAllowlist(uint256 id, address[] calldata allowlist) internal {
        delete _allowlists[id];
        for (uint256 i = 0; i < allowlist.length; i++) {
            if (allowlist[i] == address(0)) revert BadParams();
            _allowlists[id].push(allowlist[i]);
        }
        emit AllowlistUpdated(id, allowlist.length);
    }

    // ---------- views (供 PolicyVault / 前端 / facilitator 读取) ----------

    function ownerOfPolicy(uint256 id) external view returns (address) {
        return _policies[id].owner;
    }

    function policyAgent(uint256 id) external view returns (address) {
        return _policies[id].agent;
    }

    function policyToken(uint256 id) external view returns (address) {
        return _policies[id].token;
    }

    function policyValidUntil(uint256 id) external view returns (uint64) {
        return _policies[id].validUntil;
    }

    function isActive(uint256 id) external view returns (bool) {
        return _policies[id].active;
    }

    function caps(uint256 id) external view returns (uint256 perTxCap, uint256 dailyCap) {
        return (_policies[id].perTxCap, _policies[id].dailyCap);
    }

    function allowlist(uint256 id) external view returns (address[] memory) {
        return _allowlists[id];
    }

    /// @notice 空名单 = 不限制收款人
    function isPayeeAllowed(uint256 id, address payee) public view returns (bool) {
        address[] storage list = _allowlists[id];
        if (list.length == 0) return true;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == payee) return true;
        }
        return false;
    }

    /// @notice 付款前的完整规则校验 (PolicyVault 与前端预览共用同一份逻辑)
    function check(uint256 id, address payee, uint256 amount) external view returns (bool ok, string memory reason) {
        Policy storage p = _policies[id];
        if (p.owner == address(0)) return (false, "registry: policy not found");
        if (!p.active) return (false, "registry: policy inactive");
        if (block.timestamp > p.validUntil) return (false, "registry: policy expired");
        if (payee == address(0)) return (false, "registry: payee is zero address");
        if (!isPayeeAllowed(id, payee)) return (false, "registry: payee not in allowlist");
        if (amount == 0) return (false, "registry: amount is zero");
        if (amount > p.perTxCap) return (false, "registry: per-tx cap exceeded");
        return (true, "ok");
    }

    function getPolicy(uint256 id) external view returns (Policy memory) {
        return _policies[id];
    }

    function allowlistCount(uint256 id) external view returns (uint256) {
        return _allowlists[id].length;
    }
}
