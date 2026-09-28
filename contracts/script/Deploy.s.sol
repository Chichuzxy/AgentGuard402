// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC3009} from "../src/MockUSDC3009.sol";
import {AgentPolicyRegistry} from "../src/AgentPolicyRegistry.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

/// @notice 一键部署 AgentGuard402 三件套, 并把地址写成 deploy-out.json
/// 本地:  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// Fuji:  forge script script/Deploy.s.sol --rpc-url $FUJI_RPC --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        MockUSDC3009 token = new MockUSDC3009();
        AgentPolicyRegistry registry = new AgentPolicyRegistry();
        PolicyVault vault = new PolicyVault(address(registry));
        token.mint(deployer, 1000e6); // 1000 mUSDC 给部署者做演示资金
        vm.stopBroadcast();

        string memory json = string.concat(
            "{\"chainId\":",
            vm.toString(block.chainid),
            ",\"deployBlock\":",
            vm.toString(block.number),
            ",\"mockUSDC\":\"",
            vm.toString(address(token)),
            "\",\"registry\":\"",
            vm.toString(address(registry)),
            "\",\"vault\":\"",
            vm.toString(address(vault)),
            "\",\"deployer\":\"",
            vm.toString(deployer),
            "\"}\n"
        );
        vm.writeFile("deploy-out.json", json);

        console2.log("chainId  ", block.chainid);
        console2.log("block    ", block.number);
        console2.log("MockUSDC3009        ", address(token));
        console2.log("AgentPolicyRegistry ", address(registry));
        console2.log("PolicyVault         ", address(vault));
    }
}
