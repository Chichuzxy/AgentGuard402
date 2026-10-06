/**
 * 演示策略准备 —— 给"完整演示"(demo-full.js)建一组专用策略
 *
 *   DEMO_POLICY_ID     主演示: 单笔<=0.001, 每日<=0.003, 注资 0.003 mUSDC
 *                      -> 正常买 3 笔刚好把日额度用光, 第 4 笔撞日额度上限
 *   DEMO_POOR_ID       余额不足: 单笔<=0.001, 每日<=0.001, 只注资 0.0005 mUSDC
 *                      -> 要付 0.001 时金库钱不够
 *   DEMO_INACTIVE_ID   已停用: 建完立刻 setActive(false), 演示"停用策略后立即失效"
 *   DEMO_ATTACK_ID     攻击测试: 单笔<=0.001, 每日<=0.002, 注资 0.01, 先成功花掉 0.001 再拿它做重放/冒充测试
 *
 * 注意: createPolicy 要求 每日上限 >= 单笔上限, 且 validUntil 必须在未来。
 *
 * 单独跑: cd project/backend && node demo-setup.js
 * 被完整演示调用: require('./demo-setup.js').prepareDemoPolicies(cfg)
 * 每跑一次都会新建一组策略(链上留痕), 所以录视频前不用手动重置。
 */
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

const ENV_PATH = path.join(__dirname, '.env');

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

/** owner 私钥: backend/.env 的 OWNER_PRIVATE_KEY, 没填就读 contracts/.env 的 PRIVATE_KEY */
function readOwnerKey(env = process.env) {
  if (env.OWNER_PRIVATE_KEY) return env.OWNER_PRIVATE_KEY;
  const c = path.join(__dirname, '..', 'contracts', '.env');
  if (fs.existsSync(c)) {
    for (const line of fs.readFileSync(c, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*PRIVATE_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  throw new Error('没找到 owner 私钥: backend/.env 的 OWNER_PRIVATE_KEY 或 contracts/.env 的 PRIVATE_KEY');
}

const REGISTRY_ABI = [
  'function createPolicy(address agent,address token,uint256 perTxCap,uint256 dailyCap,uint64 validUntil,address[] allowlist) returns (uint256)',
  'function setActive(uint256 id, bool active)',
  'function nextPolicyId() view returns (uint256)',
];
const VAULT_ABI = ['function deposit(uint256 policyId,uint256 amount)'];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * @returns {Promise<{demo:number, poor:number, inactive:number}>}
 */
async function prepareDemoPolicies(cfg, log = () => {}) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const owner = new ethers.Wallet(cfg.ownerKey, provider);
  const registry = new ethers.Contract(cfg.registry, REGISTRY_ABI, owner);
  const vault = new ethers.Contract(cfg.vault, VAULT_ABI, owner);
  const token = new ethers.Contract(cfg.token, ERC20_ABI, owner);

  const agentAddr = new ethers.Wallet(cfg.agentKey).address;
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);

  log('note', `准备演示策略 (owner ${owner.address})`);
  await (await token.approve(cfg.vault, 100_000000n)).wait();

  async function makePolicy(label, perTx, daily, funding, active = true) {
    await (await registry.createPolicy(agentAddr, cfg.token, perTx, daily, now + 30 * day, [cfg.merchant])).wait();
    const id = Number(await registry.nextPolicyId()) - 1;
    await (await vault.deposit(id, funding)).wait();
    if (!active) await (await registry.setActive(id, false)).wait();
    log('note', `${label} 策略 #${id}  单笔<=${Number(perTx) / 1e6}  每日<=${Number(daily) / 1e6}  注资 ${Number(funding) / 1e6} mUSDC${active ? '' : '  [已停用]'}`);
    return id;
  }

  const demo = await makePolicy('主演示', 1_000n, 3_000n, 10_000n);
  const poor = await makePolicy('余额不足', 1_000n, 1_000n, 500n);
  const inactive = await makePolicy('已停用', 1_000n, 1_000n, 10_000n, false);
  // 攻击测试策略: 日额度留 0.001 的余量, 这样"冒充签名""重放""签名过期"能走到对应检查
  const attack = await makePolicy('攻击测试', 1_000n, 2_000n, 10_000n);
  return { demo, poor, inactive, attack };
}

if (require.main === module) {
  const env = loadEnv();
  (async () => {
    const ids = await prepareDemoPolicies({
      rpc: env.RPC_URL,
      chainId: Number(env.CHAIN_ID),
      registry: env.REGISTRY,
      vault: env.VAULT,
      token: env.MOCK_USDC,
      agentKey: env.AGENT_PRIVATE_KEY,
      ownerKey: readOwnerKey(env),
      merchant: env.MERCHANT_ADDRESS,
    }, (kind, text) => console.log(kind === 'note' ? '  ' + text : text));

    let text = fs.readFileSync(ENV_PATH, 'utf8');
    for (const [k, v] of Object.entries({ DEMO_POLICY_ID: ids.demo, DEMO_POOR_ID: ids.poor, DEMO_INACTIVE_ID: ids.inactive })) {
      const re = new RegExp('^' + k + '=.*$', 'm');
      text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.trimEnd() + `\n${k}=${v}\n`;
    }
    fs.writeFileSync(ENV_PATH, text);
    console.log(`\n已写回 .env: DEMO_POLICY_ID=${ids.demo} DEMO_POOR_ID=${ids.poor} DEMO_INACTIVE_ID=${ids.inactive}`);
  })().catch((e) => {
    console.error('准备失败:', e.shortMessage || e.message);
    process.exit(1);
  });
}

module.exports = { prepareDemoPolicies, readOwnerKey, loadEnv };
