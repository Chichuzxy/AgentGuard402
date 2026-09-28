/**
 * 生成本地测试用密钥 + 同步合约地址到 .env
 *
 * 只做两件事:
 *   1. 生成 facilitator / agent / merchant / attacker 四个测试网密钥 (已存在则保留, 不覆盖)
 *   2. 把 contracts/deploy-out.json 里的合约地址同步进 .env
 *
 * 用法:
 *   node setup-keys.js                                   -> 本地 anvil
 *   node setup-keys.js --rpc https://api.avax-test.network/ext/bc/C/rpc --chain 43113
 *
 * 打印出来的只有地址, 私钥只写进 .env, 不会出现在屏幕上。
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const RPC = getArg('--rpc', 'http://127.0.0.1:8545');
const CHAIN = getArg('--chain', '31337');

const envPath = path.join(__dirname, '.env');
const existing = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) existing[m[1]] = m[2].trim();
  }
}

const keep = (k) => (existing[k] && existing[k].length > 10 ? existing[k] : null);
const wallets = {
  FACILITATOR_PRIVATE_KEY: keep('FACILITATOR_PRIVATE_KEY') || ethers.Wallet.createRandom().privateKey,
  AGENT_PRIVATE_KEY: keep('AGENT_PRIVATE_KEY') || ethers.Wallet.createRandom().privateKey,
  MERCHANT_PRIVATE_KEY: keep('MERCHANT_PRIVATE_KEY') || ethers.Wallet.createRandom().privateKey,
};
const attacker = existing.ATTACKER_ADDRESS || ethers.Wallet.createRandom().address;

let deployInfo = null;
const outFile = path.join(__dirname, '..', 'contracts', 'deploy-out.json');
if (fs.existsSync(outFile)) deployInfo = JSON.parse(fs.readFileSync(outFile, 'utf8'));

const env = `# AgentGuard402 本地配置 (由 setup-keys.js 生成, 已被 .gitignore 排除)
# 这些私钥只用于测试网演示, 里面不要放主网资产。

# --- 链 ---
RPC_URL=${RPC}
CHAIN_ID=${CHAIN}

# --- 合约地址 (来自 contracts/deploy-out.json) ---
MOCK_USDC=${deployInfo ? deployInfo.mockUSDC : existing.MOCK_USDC || ''}
REGISTRY=${deployInfo ? deployInfo.registry : existing.REGISTRY || ''}
VAULT=${deployInfo ? deployInfo.vault : existing.VAULT || ''}
DEPLOY_BLOCK=${deployInfo ? deployInfo.deployBlock : existing.DEPLOY_BLOCK || 0}

# --- 三个角色私钥 (测试网临时钱包) ---
# FACILITATOR 帮 agent 上链结算, 需要一点测试 AVAX 付 gas
# AGENT       只签名付款意图, 不需要 AVAX, 也不持有代币
# MERCHANT    卖数据的 API 服务方, 收钱用
FACILITATOR_PRIVATE_KEY=${wallets.FACILITATOR_PRIVATE_KEY}
AGENT_PRIVATE_KEY=${wallets.AGENT_PRIVATE_KEY}
MERCHANT_PRIVATE_KEY=${wallets.MERCHANT_PRIVATE_KEY}
MERCHANT_ADDRESS=${new ethers.Wallet(wallets.MERCHANT_PRIVATE_KEY).address}
ATTACKER_ADDRESS=${attacker}

# --- 演示用策略编号 (bootstrap-local.js 创建后写回) ---
POLICY_ID=${existing.POLICY_ID || 1}

# --- 端口 ---
PORT=${existing.PORT || 4020}
`;
fs.writeFileSync(envPath, env, 'utf8');

console.log('已写入', envPath);
console.log('  链            ', CHAIN, RPC);
console.log('  facilitator   ', new ethers.Wallet(wallets.FACILITATOR_PRIVATE_KEY).address, '(需要测试 AVAX 付 gas)');
console.log('  agent         ', new ethers.Wallet(wallets.AGENT_PRIVATE_KEY).address, '(无需 AVAX, 不持币)');
console.log('  merchant      ', new ethers.Wallet(wallets.MERCHANT_PRIVATE_KEY).address, '(写进策略白名单)');
console.log('  attacker      ', attacker, '(故意不在白名单)');
console.log('  合约           ', deployInfo ? `${deployInfo.registry} / ${deployInfo.vault}` : '(还没部署, 先跑 forge script)');
if (CHAIN === '43113') {
  console.log('\n下一步: 去水龙头领测试 AVAX 给 facilitator(和你的钱包)');
  console.log('  https://build.avax.network/console/primary-network/faucet');
}
