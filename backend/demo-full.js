/**
 * AgentGuard402 完整演示编排 —— 一次跑完合约里全部 12 种拦截
 *
 * 第一幕: 3 笔正常采购真实上链 (拿到 tx 哈希)
 * 第二幕: 11 种越权/攻击尝试, 全部被链上策略拦下 (都在预检阶段拦截, 一分 gas 不花)
 *
 * 前置: 先跑 node demo-setup.js (建好演示策略)
 * 单独跑: node agent.js --full
 * 被服务端调用: require('./demo-full.js').runFullDemo(cfg, log)
 */
const { ethers } = require('ethers');
const { createAgent, loadEnv } = require('./agent.js');
const { prepareDemoPolicies } = require('./demo-setup.js');

const REGISTRY_ABI = [
  'function createPolicy(address agent,address token,uint256 perTxCap,uint256 dailyCap,uint64 validUntil,address[] allowlist) returns (uint256)',
  'function setActive(uint256 id, bool active)',
  'function nextPolicyId() view returns (uint256)',
];
const VAULT_ABI = [
  'function deposit(uint256 policyId,uint256 amount)',
  'function setFrozen(uint256 policyId, bool value)',
];
const ERC20_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param cfg {rpc, chainId, vault, registry, token, agentKey, ownerKey, merchant}
 * @param log (kind, text) => void   kind: head | step | pass | block | link | note
 * @param ids {demo, poor, inactive}
 */
async function runFullDemo(cfg, log, ids) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const owner = new ethers.Wallet(cfg.ownerKey, provider);
  const registry = new ethers.Contract(cfg.registry, REGISTRY_ABI, owner);
  const vaultW = new ethers.Contract(cfg.vault, VAULT_ABI, owner);
  const token = new ethers.Contract(cfg.token, ERC20_ABI, owner);
  const agent = createAgent({
    rpc: cfg.rpc,
    chainId: cfg.chainId,
    vault: cfg.vault,
    agentPrivateKey: cfg.agentKey,
    baseUrl: cfg.baseUrl,
  });
  const impostor = new ethers.Wallet(cfg.facilitatorKey || ethers.Wallet.createRandom().privateKey, provider);

  const MARKET = '/api/premium/market-data';
  const BULK = '/api/premium/bulk-dataset';
  const SCAM = '/api/premium/scam-feed';
  // 每次演示都新建一组策略, 这样日额度是满的, 可以反复录视频
  let demoId = ids && ids.demo;
  let poorId = ids && ids.poor;
  let inactiveId = ids && ids.inactive;
  let attackId = ids && ids.attack;
  if (cfg.autoPrepare) {
    const fresh = await prepareDemoPolicies(cfg, log);
    demoId = fresh.demo;
    poorId = fresh.poor;
    inactiveId = fresh.inactive;
    attackId = fresh.attack;
  }
  if (!demoId || !poorId || !inactiveId || !attackId) throw new Error('缺少演示策略, 先跑 node demo-setup.js');
  const day = 86400;
  let passed = 0;
  let blocked = 0;

  // 报一笔结果, 统一记账
  function report(r, okLabel) {
    if (r.ok) {
      passed++;
      log('pass', `${okLabel} | tx ${r.txHash} | ${r.ms}ms`);
      log('link', txLink(cfg, r.txHash));
    } else {
      blocked++;
      log('block', `被拦下 [${r.stage}] ${r.reason}`);
    }
    return r;
  }

  log('head', `AI Agent ${agent.address} 上线 —— 它没有 gas, 也不持有任何代币`);

  // ---------- 准备: 一条"马上过期"的策略 (合约不允许直接建已过期的) ----------
  await (await token.approve(cfg.vault, 100_000000n)).wait();
  const expireAt = Math.floor(Date.now() / 1000) + 30;
  await (await registry.createPolicy(
    agent.address, cfg.token, 1_000n, 1_000n, expireAt, [cfg.merchant]
  )).wait();
  const expiringId = Number(await registry.nextPolicyId()) - 1;
  await (await vaultW.deposit(expiringId, 10_000n)).wait();
  log('note', `临时建了一条 30 秒后自动过期的策略 #${expiringId}, 留到第二幕用`);

  // ---------- 第一幕: 正常放行 ----------
  log('head', '第一幕 · 正常采购 (真实上链结算)');
  let firstPaid = null;
  for (let i = 1; i <= 3; i++) {
    log('step', `正常采购行情快照 (第 ${i} 笔) -> GET ${MARKET}`);
    const r = await agent.buyRaw(MARKET, demoId, {});
    if (r.ok && i === 1) firstPaid = { intent: r.intent, signature: r.signature };
    report(r, `链上放行 · 拿到数据`);
  }
  log('note', `策略 #${demoId} 的日额度(0.003 mUSDC)已被这 3 笔用光`);
  // 再在"攻击测试"策略上正常买一笔, 留到第二幕当重放素材
  log('step', `Agent 在策略 #${attackId} 上再正常买一笔 (留作紧接着的重放素材)`);
  const rAttack = await agent.buyRaw(MARKET, attackId, {});
  if (rAttack.ok) firstPaid = { intent: rAttack.intent, signature: rAttack.signature };
  report(rAttack, '链上放行 · 拿到数据');

  // ---------- 第二幕: 越权与攻击 ----------
  log('head', '第二幕 · 越权与攻击尝试 (全部由链上策略拦下)');

  log('step', '① 额度已满, 再买一笔 -> 日额度上限');
  report(await agent.buyRaw(MARKET, demoId, {}), '');

  log('step', '② Agent 想买全量数据集 (单笔 5 mUSDC) -> 单笔上限');
  report(await agent.buyRaw(BULK, demoId, {}), '');

  log('step', '③ Agent 被诱导去买未授权接口 -> 收款人白名单');
  report(await agent.buyRaw(SCAM, demoId, {}), '');

  log('step', '④ 别人冒充 Agent 签名 (拿不到被授权地址的私钥) -> 签名必须来自被授权的 Agent');
  report(await agent.buyRaw(MARKET, attackId, { signer: impostor }), '');

  if (firstPaid) {
    log('step', '⑤ 把刚才那笔的签名原样重放一次 -> 同一个 nonce 只能用一次');
    report(await agent.buyRaw(MARKET, attackId, { replay: firstPaid }), '');
  }

  log('step', '⑥ 拿一张签名有效期已经过去的单子来花 -> 签名自带有效期');
  report(await agent.buyRaw(MARKET, attackId, { deadlineDelta: -120 }), '');

  log('step', '⑦ 金额填 0 想白拿 -> 金额不能为零');
  report(await agent.buyRaw(MARKET, demoId, { amount: 0 }), '');

  log('step', '⑧ 指定一个根本不存在的策略编号 -> 策略必须真实存在');
  report(await agent.buyRaw(MARKET, 999999, {}), '');

  // 等临时策略过期
  const waitMs = expireAt * 1000 - Date.now() + 1500;
  if (waitMs > 0) {
    log('note', `等临时策略 #${expiringId} 过期 (约 ${Math.ceil(waitMs / 1000)} 秒)`);
    await sleep(waitMs);
  }
  log('step', `⑨ 用已过期的策略 #${expiringId} 付款 -> 策略有效期`);
  report(await agent.buyRaw(MARKET, expiringId, {}), '');

  log('step', `⑩ 用已被停用的策略 #${inactiveId} 付款 -> 停用策略后立即失效`);
  report(await agent.buyRaw(MARKET, inactiveId, {}), '');

  log('step', `⑪ 策略 #${poorId} 金库只剩 0.0005 mUSDC, 却要付 0.001 -> 金库余额不足`);
  report(await agent.buyRaw(MARKET, poorId, {}), '');

  // ---------- 第三幕: 老板一键停机 ----------
  log('head', '第三幕 · 老板发现异常, 一键停机');
  log('step', `冻结策略 #${demoId} 的资金`);
  await (await vaultW.setFrozen(demoId, true)).wait();
  log('note', `策略 #${demoId} 资金已冻结 (策略本身仍启用)`);
  log('step', 'Agent 再尝试采购 -> 资金冻结');
  report(await agent.buyRaw(MARKET, demoId, {}), '');
  log('step', `解冻策略 #${demoId}, 恢复正常`);
  await (await vaultW.setFrozen(demoId, false)).wait();
  log('note', `策略 #${demoId} 已解冻`);

  log('head', `本轮结束: 放行 ${passed} 笔, 拦下 ${blocked} 笔 —— 拦截全部发生在链上策略层, Agent 无法绕过`);
  return { passed, blocked };
}

function txLink(cfg, hash) {
  return `https://testnet.snowtrace.io/tx/${hash}`;
}

// ---------- 命令行模式 ----------
async function runFullDemoCli() {
  loadEnv();
  const e = process.env;
  const ids = {
    demo: Number(e.DEMO_POLICY_ID),
    poor: Number(e.DEMO_POOR_ID),
    inactive: Number(e.DEMO_INACTIVE_ID),
  };
  const path = require('path');
  const fs = require('fs');
  let ownerKey = e.OWNER_PRIVATE_KEY;
  if (!ownerKey) {
    const c = path.join(__dirname, '..', 'contracts', '.env');
    if (fs.existsSync(c)) {
      for (const line of fs.readFileSync(c, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*PRIVATE_KEY\s*=\s*(.+)\s*$/);
        if (m) ownerKey = m[1].replace(/^["']|["']$/g, '').trim();
      }
    }
  }
  const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  await runFullDemo(
    {
      rpc: e.RPC_URL,
      chainId: Number(e.CHAIN_ID),
      vault: e.VAULT,
      registry: e.REGISTRY,
      token: e.MOCK_USDC,
      agentKey: e.AGENT_PRIVATE_KEY,
      facilitatorKey: e.FACILITATOR_PRIVATE_KEY,
      ownerKey,
      merchant: e.MERCHANT_ADDRESS,
      baseUrl: `http://127.0.0.1:${e.PORT || 4020}`,
      autoPrepare: true,
    },
    (kind, text) => console.log(`[${stamp()}] ${kind === 'head' ? '== ' : kind === 'note' ? '-- ' : '   '}${text}`),
    ids
  );
}

module.exports = { runFullDemo, runFullDemoCli };
