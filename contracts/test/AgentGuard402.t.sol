// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockUSDC3009} from "../src/MockUSDC3009.sol";
import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

contract AgentGuard402Test is Test {
    MockUSDC3009 token;
    AgentPolicyRegistry registry;
    PolicyVault vault;

    uint256 ownerPk = 0xA11CE;
    uint256 agentPk = 0xB0B; // 授权 agent 私钥 (测试用)
    uint256 roguePk = 0xBAD; // 未授权 agent 私钥

    address owner;
    address agent;
    address rogue;
    address merchant1 = address(0x1111);
    address merchant2 = address(0x2222);

    uint256 policyId;
    uint256 constant ONE_MUSDC = 1e6;
    uint256 constant PER_TX = 1e6; // 单笔 1 mUSDC
    uint256 constant DAILY = 3e6; // 每日 3 mUSDC
    uint256 constant FUNDED = 10e6; // 存入 10 mUSDC
    uint256 constant POLICY_DAYS = 7;

    function setUp() public {
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        rogue = vm.addr(roguePk);

        vm.warp(1_770_000_000); // 固定起点, 让"天"边界可控
        token = new MockUSDC3009();
        registry = new AgentPolicyRegistry();
        vault = new PolicyVault(address(registry));

        token.mint(owner, 1000e6);

        address[] memory allow = new address[](1);
        allow[0] = merchant1;
        vm.prank(owner);
        policyId = registry.createPolicy(
            agent, address(token), PER_TX, DAILY, uint64(block.timestamp + POLICY_DAYS * 1 days), allow
        );

        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(policyId, FUNDED);
        vm.stopPrank();
    }

    // ---------- helpers ----------

    function _intent(address payee, uint256 amount, uint256 nonce)
        internal
        view
        returns (PolicyVault.PaymentIntent memory)
    {
        return PolicyVault.PaymentIntent({
            policyId: policyId,
            payee: payee,
            amount: amount,
            nonce: nonce,
            deadline: uint64(block.timestamp + 5 minutes),
            resourceId: keccak256("GET /api/premium/market-data")
        });
    }

    function _sign(PolicyVault.PaymentIntent memory intent, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = vault.hashTypedIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice 用 agent 私钥签名的付款意图
    function _agentIntent(address payee, uint256 amount, uint256 nonce) internal view returns (PolicyVault.PaymentIntent memory, bytes memory) {
        PolicyVault.PaymentIntent memory intent = _intent(payee, amount, nonce);
        return (intent, _sign(intent, agentPk));
    }

    // ---------- 正常路径 ----------

    function testHappyPathSettlesAndPays() public {
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 1);

        (bool ok, string memory reason,,) = vault.checkPayment(intent, sig);
        assertTrue(ok, reason);

        vault.settle(intent, sig);

        assertEq(token.balanceOf(merchant1), ONE_MUSDC, "merchant should receive money");
        assertEq(vault.policyBalance(policyId), FUNDED - ONE_MUSDC, "vault balance down");
        assertEq(vault.spentToday(policyId), ONE_MUSDC, "daily spent recorded");
        assertEq(vault.paymentCount(policyId), 1, "payment counted");
    }

    function testAgentNeverHoldsFunds() public {
        // agent 手里本来就没有币: 钱在 vault 里, agent 只有签名权
        assertEq(token.balanceOf(agent), 0);
        assertEq(vault.policyBalance(policyId), FUNDED);
    }

    // ---------- 护栏逐条拦截 ----------

    function testPerTxCapRejected() public {
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, PER_TX + 1, 2);
        vm.expectRevert(bytes("registry: per-tx cap exceeded"));
        vault.settle(intent, sig);
    }

    function testPayeeNotInAllowlistRejected() public {
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant2, ONE_MUSDC, 3);
        vm.expectRevert(bytes("registry: payee not in allowlist"));
        vault.settle(intent, sig);
    }

    function testDailyCapRejected() public {
        for (uint256 i = 10; i < 13; i++) {
            (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, i);
            vault.settle(intent, sig);
        }
        assertEq(vault.spentToday(policyId), DAILY);

        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 13);
        vm.expectRevert(bytes("vault: daily cap exceeded"));
        vault.settle(intent, sig);
    }

    function testDailyCapResetsNextDay() public {
        for (uint256 i = 20; i < 23; i++) {
            (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, i);
            vault.settle(intent, sig);
        }
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.spentToday(policyId), 0, "new day resets the counter");

        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 23);
        vault.settle(intent, sig);
        assertEq(vault.spentToday(policyId), ONE_MUSDC);
    }

    function testExpiredIntentRejected() public {
        PolicyVault.PaymentIntent memory intent = _intent(merchant1, ONE_MUSDC, 30);
        intent.deadline = uint64(block.timestamp - 1);
        bytes memory sig = _sign(intent, agentPk);

        vm.expectRevert(bytes("intent: expired"));
        vault.settle(intent, sig);
    }

    function testExpiredPolicyRejected() public {
        vm.warp(block.timestamp + POLICY_DAYS * 1 days + 1);
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 31);
        vm.expectRevert(bytes("registry: policy expired"));
        vault.settle(intent, sig);
    }

    function testNonceReplayRejected() public {
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 40);
        vault.settle(intent, sig);

        vm.expectRevert(bytes("vault: nonce already used"));
        vault.settle(intent, sig);
    }

    function testWrongSignerRejected() public {
        PolicyVault.PaymentIntent memory intent = _intent(merchant1, ONE_MUSDC, 50);
        bytes memory sig = _sign(intent, roguePk); // 不是被授权的 agent

        vm.expectRevert(bytes("intent: bad signature (not the authorized agent)"));
        vault.settle(intent, sig);
    }

    function testTamperedAmountRejected() public {
        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 60);
        intent.amount = 500_000; // 签名后改金额(仍在上限内) -> 签名失效
        vm.expectRevert(bytes("intent: bad signature (not the authorized agent)"));
        vault.settle(intent, sig);
    }

    // ---------- 主人的两个开关 ----------

    function testFreezeBlocksImmediately() public {
        vm.prank(owner);
        vault.setFrozen(policyId, true);

        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 70);
        vm.expectRevert(bytes("vault: policy frozen"));
        vault.settle(intent, sig);
    }

    function testRegistryDeactivateBlocksAgent() public {
        vm.prank(owner);
        registry.setActive(policyId, false);

        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 80);
        vm.expectRevert(bytes("registry: policy inactive"));
        vault.settle(intent, sig);
    }

    function testRotateAgentMovesSigningRight() public {
        vm.prank(owner);
        registry.rotateAgent(policyId, rogue);

        (PolicyVault.PaymentIntent memory intent, bytes memory sig) = _agentIntent(merchant1, ONE_MUSDC, 90);
        vm.expectRevert(bytes("intent: bad signature (not the authorized agent)"));
        vault.settle(intent, sig);

        PolicyVault.PaymentIntent memory intent2 = _intent(merchant1, ONE_MUSDC, 91);
        vault.settle(intent2, _sign(intent2, roguePk));
        assertEq(token.balanceOf(merchant1), ONE_MUSDC);
    }

    function testOnlyOwnerCanWithdraw() public {
        vm.prank(merchant2);
        vm.expectRevert(AgentPolicyRegistry.NotPolicyOwner.selector);
        vault.withdraw(policyId, ONE_MUSDC);

        vm.prank(owner);
        vault.withdraw(policyId, FUNDED);
        assertEq(token.balanceOf(owner), 1000e6, "owner got the money back");
        assertEq(vault.policyBalance(policyId), 0);
    }

    // ---------- 预览 = 执行的同一份逻辑 ----------

    function testPreviewMatchesExecution() public {
        (PolicyVault.PaymentIntent memory bad, bytes memory badSig) =
            _agentIntent(merchant1, PER_TX + 1, 100);
        (bool ok, string memory reason,,) = vault.checkPayment(bad, badSig);
        assertFalse(ok);
        assertEq(reason, "registry: per-tx cap exceeded");

        vm.expectRevert(bytes("registry: per-tx cap exceeded"));
        vault.settle(bad, badSig);
    }

    // ---------- 对照: 没有护栏的裸 x402/EIP-3009 语义 ----------

    function testRawEip3009HasNoSpendingLimit() public {
        // 对照实验: agent 自己持币走裸 EIP-3009, 一笔就能把全部余额付出去,
        // 链上没有任何额度概念 —— 这正是本项目要补的那一块。
        address agentEoa = agent;
        token.mint(agentEoa, 5e6);
        uint256 amount = 5e6;
        bytes32 nonce = keccak256("raw");
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), agentEoa, merchant2, amount, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);

        token.transferWithAuthorization(agentEoa, merchant2, amount, validAfter, validBefore, nonce, v, r, s);
        assertEq(token.balanceOf(merchant2), amount, "raw 3009 has no spending limit");
    }
}
