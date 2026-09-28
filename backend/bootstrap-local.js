/**
 * 一键铺场景 (本地 anvil / Fuji 通用):
 *   1. 用 owner 私钥当"出钱方" (OWNER_PRIVATE_KEY, 本地回落 anvil 第 0 个账号), 给它铸 1000 mUSDC
 *   2. 本地: 给 facilitator / agent / merchant 各转 10 AVAX 当 gas; Fuji: 只体检余额, 不自转
 *   3. 建策略: agent 能用, 单笔 <= 1 mUSDC, 每日 <= 3 mUSDC, 白名单只有 merchant
 *   4. 往 vault 注资 10 mUSDC
 *   5. 把 POLICYY_ID 写回 .env, 并打印结果
 *
 * 前提: 合约已部署 (contracts/deploy-out.json 存在) + 已跑过 setup-keys.js + 本地链需 anvil 在跑
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ANVIL_OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil 公开测试账号, 仅本地链使用

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('缺 .env, 先跑: node setup-keys.js');
  process.exit(1);
}
const envText = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
}

// 只有本地链(31337)才自动转 gas; Fuji 上各角色用自己的币
const IS_LOCAL = Number(env.CHAIN_ID) === 31337;

/**
 * 出钱方私钥:
 *   本地链 -> anvil 第 0 个账号 (只有它在本地链上有钱)
 *   Fuji  -> backend/.env 的 OWNER_PRIVATE_KEY, 没填就读 ../contracts/.env 的 PRIVATE_KEY
 */
function resolveOwnerKey() {
  if (IS_LOCAL) return ANVIL_OWNER_KEY;
  if (env.OWNER_PRIVATE_KEY) return env.OWNER_PRIVATE_KEY;
  const cPath = path.join(__dirname, '..', 'contracts', '.env');
  if (fs.existsSync(cPath)) {
    const m = fs.readFileSync(cPath, 'utf8').match(/^\s*PRIVATE_KEY\s*=\s*(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  console.error('没找到 owner 私钥: 在 backend/.env 填 OWNER_PRIVATE_KEY, 或在 contracts/.env 填 PRIVATE_KEY');
  process.exit(1);
}
const OWNER_KEY = resolveOwnerKey();

const REGISTRY_ABI = [
  'function createPolicy(address agent,address token,uint256 perTxCap,uint256 dailyCap,uint64 validUntil,address[] allowlist) returns (uint256)',
  'function nextPolicyId() view returns (uint256)',
  'function getPolicy(uint256 id) view returns (address owner,address agent,address token,uint256 perTxCap,uint256 dailyCap,uint64 validUntil,bool active)',
  'function allowlist(uint256 id) view returns (address[])',
];
const VAULT_ABI = [
  'function deposit(uint256 policyId,uint256 amount)',
  'function policyBalance(uint256) view returns (uint256)',
];
const ERC20_ABI = ['function mint(address to,uint256 amount)', 'function approve(address spender,uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

(async () => {
  const provider = new ethers.JsonRpcProvider(env.RPC_URL, Number(env.CHAIN_ID));
  // NonceManager: 连续发多笔交易时本地自增 nonce, 避免 ethers 的非ce 缓存打架
  const ownerWallet = new ethers.Wallet(OWNER_KEY, provider);
  const owner = new ethers.NonceManager(ownerWallet);
  const ownerAddr = ownerWallet.address;
  const token = new ethers.Contract(env.MOCK_USDC, ERC20_ABI, owner);
  const registry = new ethers.Contract(env.REGISTRY, REGISTRY_ABI, owner);
  const vault = new ethers.Contract(env.VAULT, VAULT_ABI, owner);

  console.log('owner      ', ownerAddr);
  await (await token.mint(ownerAddr, 1000_000000n)).wait();
  console.log('mint       ', '1000 mUSDC -> owner');

  for (const [label, key] of [
    ['facilitator', env.FACILITATOR_PRIVATE_KEY],
    ['agent', env.AGENT_PRIVATE_KEY],
    ['merchant', env.MERCHANT_PRIVATE_KEY],
  ]) {
    const addr = new ethers.Wallet(key).address;
    if (IS_LOCAL) {
      await (await owner.sendTransaction({ to: addr, value: ethers.parseEther('10') })).wait();
      console.log('fund gas   ', label, addr, '10 AVAX');
    } else {
      const bal = await provider.getBalance(addr);
      // 只有 facilitator 需要 gas 付交易; agent 只签名, merchant 只收款, 它们没币是正常的
      const needGas = label === 'facilitator';
      const note = needGas
        ? (bal < ethers.parseEther('0.05') ? '  <- 不足 0.05 AVAX, 去水龙头领' : '')
        : '  (设计上不需要 AVAX)';
      console.log('gas check  ', label.padEnd(11), addr, ethers.formatEther(bal), 'AVAX' + note);
    }
  }

  const perTxCap = 1_000000n; // 1 mUSDC
  const dailyCap = 3_000000n; // 3 mUSDC
  const validUntil = Math.floor(Date.now() / 1000) + 7 * 86400;
  const tx = await registry.createPolicy(env.AGENT_PRIVATE_KEY ? new ethers.Wallet(env.AGENT_PRIVATE_KEY).address : env.MERCHANT_ADDRESS, env.MOCK_USDC, perTxCap, dailyCap, validUntil, [env.MERCHANT_ADDRESS]);
  const rc = await tx.wait();
  const policyId = Number(await registry.nextPolicyId()) - 1;
  console.log('policy     ', `#${policyId} 单笔<=1 每日<=3 白名单=[merchant] 到期=${new Date(validUntil * 1000).toISOString()}`);

  await (await token.approve(env.VAULT, ethers.MaxUint256)).wait();
  await (await vault.deposit(policyId, 10_000000n)).wait();
  console.log('deposit    ', '10 mUSDC -> vault, 余额', (await vault.policyBalance(policyId)).toString());

  const updated = envText.replace(/^POLICY_ID=.*$/m, `POLICY_ID=${policyId}`);
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log('\nPOLICY_ID 已写回 .env =', policyId);
  console.log('下一步: node server.js  (然后浏览器打开 http://127.0.0.1:' + (env.PORT || 4020) + ')');
})().catch((e) => {
  console.error('失败了:', e.shortMessage || e.message);
  process.exit(1);
});
