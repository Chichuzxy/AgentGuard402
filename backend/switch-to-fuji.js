/**
 * 把 contracts/deploy-out.json 里的合约地址同步进 backend/.env
 * 用法: node switch-to-fuji.js       (自动按 chainId 选 RPC)
 * chainId 43113 -> Fuji, 31337 -> 本地 anvil
 */
const fs = require('fs');
const path = require('path');

const outPath = path.join(__dirname, '..', 'contracts', 'deploy-out.json');
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(outPath)) { console.error('找不到 contracts/deploy-out.json, 先部署合约'); process.exit(1); }
if (!fs.existsSync(envPath)) { console.error('找不到 .env, 先跑 node setup-keys.js'); process.exit(1); }

const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
const RPC = { 43113: 'https://api.avax-test.network/ext/bc/C/rpc', 31337: 'http://127.0.0.1:8545' };
const want = {
  RPC_URL: RPC[Number(out.chainId)] || RPC[31337],
  CHAIN_ID: String(out.chainId),
  MOCK_USDC: out.mockUSDC,
  REGISTRY: out.registry,
  VAULT: out.vault,
  DEPLOY_BLOCK: String(out.deployBlock),
  POLICY_ID: '1',
};

let text = fs.readFileSync(envPath, 'utf8');
const seen = new Set();
text = text.replace(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm, (line, k) => {
  if (!(k in want)) return line;
  seen.add(k);
  return `${k}=${want[k]}`;
});
for (const k of Object.keys(want)) if (!seen.has(k)) text += `\n${k}=${want[k]}`;
fs.writeFileSync(envPath, text, 'utf8');

console.log('已同步到 .env:');
for (const k of Object.keys(want)) console.log('  ' + k.padEnd(12), want[k]);
console.log('\n链:', Number(out.chainId) === 43113 ? 'Fuji 测试网' : '本地 anvil', '| 部署者:', out.deployer);
