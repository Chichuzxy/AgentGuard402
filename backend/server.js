/**
 * AgentGuard402 - x402 付费资源服务 + 带策略护栏的 facilitator
 *
 * 一个服务三件事:
 *   1. 卖数据: x402 握手 (402 -> PAYMENT-REQUIRED -> PAYMENT-SIGNATURE -> 放行)
 *   2. 护栏: 结算前先在链上问策略合约"这笔能不能过", 不能过就如实回原因
 *   3. 结算: facilitator 上链调 vault.settle(), 只付 gas, 无权动钱
 *
 * 零依赖 (原生 http), 只用 ethers 做 ABI/签名收发。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

// ---------- .env ----------
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
})();

const CFG = {
  rpc: process.env.RPC_URL || 'http://127.0.0.1:8545',
  chainId: Number(process.env.CHAIN_ID || 31337),
  usdc: process.env.MOCK_USDC || '',
  registry: process.env.REGISTRY || '',
  vault: process.env.VAULT || '',
  deployBlock: Number(process.env.DEPLOY_BLOCK || 0),
  port: Number(process.env.PORT || 4020),
  merchant: process.env.MERCHANT_ADDRESS || '',
  attacker: process.env.ATTACKER_ADDRESS || '',
  policyId: Number(process.env.POLICY_ID || 1),
};

const EXPLORERS = { 43114: 'https://snowtrace.io', 43113: 'https://testnet.snowtrace.io' };
const explorer = EXPLORERS[CFG.chainId] || 'http://localhost:8545';
const txUrl = (h) => `${explorer}/tx/${h}`;

const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);

const REGISTRY_ABI = [
  'function getPolicy(uint256 id) view returns (address owner,address agent,address token,uint256 perTxCap,uint256 dailyCap,uint64 validUntil,bool active)',
  'function allowlist(uint256 id) view returns (address[])',
  'function check(uint256 id,address payee,uint256 amount) view returns (bool ok,string reason)',
  'function nextPolicyId() view returns (uint256)',
];
const VAULT_ABI = [
  'function policyBalance(uint256) view returns (uint256)',
  'function spentToday(uint256) view returns (uint256)',
  'function frozen(uint256) view returns (bool)',
  'function paymentCount(uint256) view returns (uint256)',
  'function checkPayment((uint256 policyId,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 resourceId) intent, bytes signature) view returns (bool ok,string reason,uint256 remainingDaily,uint256 vaultBalance)',
  'function settle((uint256 policyId,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 resourceId) intent, bytes signature) returns (uint256 spentToday)',
  'function hashTypedIntent((uint256 policyId,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 resourceId) intent) view returns (bytes32)',
  'event PaymentSettled(uint256 indexed policyId,address indexed agent,address indexed payee,uint256 amount,uint256 nonce,bytes32 resourceId,uint256 spentToday)',
];
const ERC20_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'];

const registryC = new ethers.Contract(CFG.registry, REGISTRY_ABI, provider);
const vaultC = new ethers.Contract(CFG.vault, VAULT_ABI, provider);
const tokenC = new ethers.Contract(CFG.usdc, ERC20_ABI, provider);
const facilitatorWallet = process.env.FACILITATOR_PRIVATE_KEY
  ? new ethers.Wallet(process.env.FACILITATOR_PRIVATE_KEY, provider)
  : null;
const facilitator = facilitatorWallet ? { address: facilitatorWallet.address } : null;
// NonceManager: facilitator 连续结算多笔时本地自增 nonce, 避免连发交易撞 nonce
const vaultW = facilitatorWallet ? new ethers.Contract(CFG.vault, VAULT_ABI, new ethers.NonceManager(facilitatorWallet)) : null;

// ---------- 货架: 每个端点明码标价 ----------
const CATALOG = {
  '/api/premium/market-data': {
    price: 1000n,
    payTo: CFG.merchant,
    desc: 'AVAX/USDC 行情快照 (0.001 mUSDC/次, 白名单内收款人)',
  },
  '/api/premium/bulk-dataset': {
    price: 2_000_000n,
    payTo: CFG.merchant,
    desc: '全量历史数据集 (2 mUSDC/次, 故意超过单笔上限)',
  },
  '/api/premium/scam-feed': {
    price: 1000n,
    payTo: CFG.attacker,
    desc: '未授权收款人提供的接口 (用来演示白名单拦截)',
  },
};

// agent 用 ethers.id(route) 当链上 resourceId, 这里建反向映射, 让审计流水直接显示商品名
const ITEM_BY_RESOURCE = Object.fromEntries(
  Object.entries(CATALOG).map(([route, v]) => [ethers.id(route).toLowerCase(), v.desc])
);

// ---------- 工具 ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const json = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers });
  res.end(payload);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });

function toIntent(raw) {
  return {
    policyId: BigInt(raw.policyId),
    payee: ethers.getAddress(raw.payee),
    amount: BigInt(raw.amount),
    nonce: BigInt(raw.nonce),
    deadline: BigInt(raw.deadline),
    resourceId: raw.resourceId,
  };
}

function challenge(route, item) {
  return {
    x402Version: 2,
    scheme: 'exact-guarded',
    network: `eip155:${CFG.chainId}`,
    resource: route,
    description: item.desc,
    mimeType: 'application/json',
    maxTimeoutSeconds: 60,
    asset: CFG.usdc,
    payTo: item.payTo,
    maxAmountRequired: item.price.toString(),
    extra: {
      note: 'x402 握手 + 链上策略合约结算 (exact-guarded): agent 签名授权, facilitator 代提交, vault 合约强制额度/白名单',
      vault: CFG.vault,
      registry: CFG.registry,
      policyId: CFG.policyId,
      facilitator: facilitator ? facilitator.address : null,
      x402Baseline: '标准 exact/EIP-3009 会直接由 agent 持币付款, 链上没有任何额度概念',
    },
  };
}

/** 链上策略预检 (不含签名) */
async function policyPrecheck(policyId, payee, amount) {
  const [ok, reason] = await registryC.check(policyId, payee, amount);
  const [frozen, balance, spentToday] = await Promise.all([
    vaultC.frozen(policyId),
    vaultC.policyBalance(policyId),
    vaultC.spentToday(policyId),
  ]);
  const policy = await registryC.getPolicy(policyId);
  const remainingDaily = policy.dailyCap > spentToday ? (policy.dailyCap - spentToday).toString() : '0';
  if (frozen) return { isValid: false, reason: 'vault: policy frozen', remainingDaily };
  if (!ok) return { isValid: false, reason, remainingDaily };
  // 检查顺序必须和合约 checkPayment 一致: 先看今天还能花多少, 再看金库余额
  if (amount > policy.dailyCap - spentToday) return { isValid: false, reason: 'vault: daily cap exceeded', remainingDaily };
  if (amount > balance) return { isValid: false, reason: 'vault: insufficient vault balance', remainingDaily };
  return { isValid: true, reason: 'ok', remainingDaily, vaultBalance: balance.toString() };
}

/** 真·链上校验 (带签名, 与 settle 完全同一条代码路径) */
async function onchainCheck(intent, signature) {
  const r = await vaultC.checkPayment(intent, signature);
  return { isValid: r[0], reason: r[1], remainingDaily: r[2].toString(), vaultBalance: r[3].toString() };
}

// ---------- 结算 (facilitator 上链) ----------
async function settlePayment(intent, signature) {
  if (!vaultW) return { success: false, error: 'facilitator key not configured' };
  const pre = await onchainCheck(intent, signature);
  if (!pre.isValid) return { success: false, error: pre.reason, blocked: true };
  try {
    const tx = await vaultW.settle(intent, signature);
    const rc = await tx.wait();
    return { success: true, txHash: rc.hash, block: rc.blockNumber, explorer: txUrl(rc.hash), remainingDaily: pre.remainingDaily };
  } catch (e) {
    return { success: false, error: e.shortMessage || e.message };
  }
}

// ---------- 审计流水 ----------
async function auditTrail(policyId) {
  const filter = vaultC.filters.PaymentSettled(policyId);
  const logs = await vaultC.queryFilter(filter, CFG.deployBlock);
  const out = [];
  for (const l of logs) {
    const block = await provider.getBlock(l.blockNumber);
    out.push({
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      time: new Date(Number(block.timestamp) * 1000).toISOString(),
      agent: l.args.agent,
      payee: l.args.payee,
      amount: l.args.amount.toString(),
      resourceId: l.args.resourceId,
      item: ITEM_BY_RESOURCE[String(l.args.resourceId).toLowerCase()] || null,
      spentToday: l.args.spentToday.toString(),
      explorer: txUrl(l.transactionHash),
    });
  }
  return out.reverse();
}

// ---------- Agent 演示运行器 ----------
const agentState = { running: false, log: [], startedAt: null, summary: null };
function pushLog(kind, text) {
  agentState.log.push({ t: new Date().toISOString().slice(11, 19), kind, text });
  if (agentState.log.length > 300) agentState.log.shift();
}

async function runAgentDemo(policyId) {
  if (agentState.running) return { started: false, reason: 'already running' };
  agentState.running = true;
  agentState.log = [];
  agentState.summary = null;
  const { createAgent } = require('./agent.js');
  const agent = createAgent({
    rpc: CFG.rpc,
    chainId: CFG.chainId,
    vault: CFG.vault,
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY,
    baseUrl: `http://127.0.0.1:${CFG.port}`,
  });

  (async () => {
    let passed = 0,
      blocked = 0;
    pushLog('head', `AI Agent ${agent.address} 开始自主采购 (它没有 gas, 也不持有任何代币)`);
    const plan = [
      ['/api/premium/market-data', '正常采购行情快照', true],
      ['/api/premium/market-data', '正常采购行情快照', true],
      ['/api/premium/market-data', '正常采购行情快照', true],
      ['/api/premium/bulk-dataset', 'Agent 想买全量数据集 (超单笔上限)', false],
      ['/api/premium/scam-feed', 'Agent 被诱导去买未授权接口', false],
    ];
    for (const [url, label] of plan) {
      pushLog('step', `${label} -> GET ${url}`);
      try {
        const r = await agent.buy(url, policyId);
        if (r.ok) {
          passed++;
          pushLog('pass', `链上放行 ${r.data.symbol || ''} 报价 ${r.data.price || ''} | tx ${r.txHash} | ${r.ms}ms`);
          pushLog('link', txUrl(r.txHash));
        } else {
          blocked++;
          pushLog('block', `被拦截 (${r.stage}): ${r.reason}`);
        }
      } catch (e) {
        blocked++;
        pushLog('block', `被拦截: ${e.message}`);
      }
    }
    pushLog('head', `本轮结束: 放行 ${passed} 笔, 拦截 ${blocked} 笔 —— 拦截全部发生在链上策略层, agent 无法绕过`);
    agentState.summary = { passed, blocked };
    agentState.running = false;
  })().catch((e) => {
    pushLog('block', 'demo error: ' + e.message);
    agentState.running = false;
  });
  return { started: true };
}

/** 完整演示: 一次覆盖合约里全部 12 种拦截。会自动先准备一组新的演示策略, 保证可以反复录视频。 */
async function runFullAgentDemo() {
  if (agentState.running) return { started: false, reason: 'already running' };
  agentState.running = true;
  agentState.log = [];
  agentState.summary = null;
  agentState.startedAt = Date.now();
  const { runFullDemo } = require('./demo-full.js');
  const { readOwnerKey } = require('./demo-setup.js');

  (async () => {
    try {
      const summary = await runFullDemo(
        {
          rpc: CFG.rpc,
          chainId: CFG.chainId,
          vault: CFG.vault,
          registry: CFG.registry,
          token: CFG.usdc,
          agentKey: process.env.AGENT_PRIVATE_KEY,
          facilitatorKey: process.env.FACILITATOR_PRIVATE_KEY,
          ownerKey: readOwnerKey(process.env),
          merchant: CFG.merchant,
          baseUrl: `http://127.0.0.1:${CFG.port}`,
          autoPrepare: true,
        },
        pushLog,
        {}
      );
      agentState.summary = summary;
    } catch (e) {
      pushLog('block', '演示中断: ' + (e.shortMessage || e.message));
      console.error('[run-full] 中断堆栈:', e.stack);
      agentState.summary = { error: e.message };
    } finally {
      agentState.running = false;
    }
  })();
  return { started: true };
}

// ---------- HTTP 路由 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,payment-signature', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  // --- 静态前端 ---
  if (route === '/' || route === '/index.html') {
    return sendFile(res, path.join(__dirname, '..', 'frontend', 'index.html'));
  }
  if (route.startsWith('/vendor/')) {
    return sendFile(res, path.join(__dirname, 'node_modules', 'ethers', 'dist', route.replace('/vendor/', '')));
  }

  // --- 配置 ---
  if (route === '/api/config') {
    const symbol = await tokenC.symbol().catch(() => 'mUSDC');
    const decimals = await tokenC.decimals().catch(() => 6);
    return json(res, 200, {
      chainId: CFG.chainId,
      network: CFG.chainId === 43114 ? 'Avalanche C-Chain' : CFG.chainId === 43113 ? 'Avalanche Fuji' : `chain ${CFG.chainId}`,
      explorer,
      rpc: CFG.rpc,
      contracts: { mockUSDC: CFG.usdc, registry: CFG.registry, vault: CFG.vault },
      token: { symbol, decimals: Number(decimals) },
      roles: { merchant: CFG.merchant, attacker: CFG.attacker, facilitator: facilitator ? facilitator.address : null, agent: process.env.AGENT_PRIVATE_KEY ? new ethers.Wallet(process.env.AGENT_PRIVATE_KEY).address : null },
      defaultPolicyId: CFG.policyId,
      catalog: Object.entries(CATALOG).map(([k, v]) => ({ route: k, price: v.price.toString(), payTo: v.payTo, desc: v.desc })),
      x402: { spec: 'https://docs.x402.org', scheme: 'exact-guarded', avalancheListed: 'Avalanche C-Chain 已在 x402 官方支持网络表 (eip155:43114, USDC, EIP-3009)' },
    });
  }

  // --- 策略读取 ---
  const policyMatch = route.match(/^\/api\/policy\/(\d+)$/);
  if (policyMatch) {
    const id = Number(policyMatch[1]);
    const p = await registryC.getPolicy(id);
    if (p.owner === ethers.ZeroAddress) return json(res, 404, { error: 'policy not found' });
    const [balance, spentToday, frozen, count, list, nextId] = await Promise.all([
      vaultC.policyBalance(id),
      vaultC.spentToday(id),
      vaultC.frozen(id),
      vaultC.paymentCount(id),
      registryC.allowlist(id),
      registryC.nextPolicyId(),
    ]);
    return json(res, 200, {
      policyId: id,
      owner: p.owner,
      agent: p.agent,
      token: p.token,
      perTxCap: p.perTxCap.toString(),
      dailyCap: p.dailyCap.toString(),
      validUntil: Number(p.validUntil),
      active: p.active,
      allowlist: list,
      vaultBalance: balance.toString(),
      spentToday: spentToday.toString(),
      remainingDaily: p.dailyCap > spentToday ? (p.dailyCap - spentToday).toString() : '0',
      frozen,
      paymentCount: count.toString(),
      totalPolicies: Number(nextId) - 1,
      explorer,
    });
  }

  // --- 审计流水 ---
  if (route === '/api/audit') {
    const id = Number(url.searchParams.get('policyId') || CFG.policyId);
    return json(res, 200, { policyId: id, payments: await auditTrail(id) });
  }

  // --- 付款预览 (只读, 不花钱) ---
  if (route === '/api/preview') {
    const b = await readBody(req);
    const id = Number(b.policyId || CFG.policyId);
    const r = await policyPrecheck(id, b.payee, BigInt(b.amount));
    return json(res, 200, { ...r, policyId: id, payee: b.payee, amount: String(b.amount) });
  }

  // --- x402: /verify ---
  if (route === '/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const intent = toIntent(b.payload.intent);
    const accepts = b.accepts || {};
    if (b.payload.signature) {
      const r = await onchainCheck(intent, b.payload.signature);
      return json(res, 200, { isValid: r.isValid, reason: r.reason, payer: intent.payee, remainingDaily: r.remainingDaily, check: 'onchain checkPayment (与 settle 同一路径)' });
    }
    const r = await policyPrecheck(intent.policyId, intent.payee, intent.amount);
    return json(res, 200, { isValid: r.isValid, reason: r.reason, remainingDaily: r.remainingDaily, check: 'policy precheck (未签名先预检)' });
  }

  // --- x402: /settle ---
  if (route === '/settle' && req.method === 'POST') {
    const b = await readBody(req);
    const intent = toIntent(b.payload.intent);
    const r = await settlePayment(intent, b.payload.signature);
    return json(res, 200, { ...r, network: `eip155:${CFG.chainId}`, settled: !!r.success });
  }

  // --- Agent 演示 ---
  if (route === '/api/agent/run' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, await runAgentDemo(Number(b.policyId || CFG.policyId)));
  }
  if (route === '/api/agent/run-full' && req.method === 'POST') {
    return json(res, 200, await runFullAgentDemo());
  }
  if (route === '/api/agent/status') {
    return json(res, 200, agentState);
  }

  // --- 付费资源 (x402 握手) ---
  if (CATALOG[route]) {
    const item = CATALOG[route];
    const sigHeader = req.headers['payment-signature'];
    if (!sigHeader) {
      return json(res, 402, { error: 'Payment required', x402Version: 2 }, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: [challenge(route, item)] }) });
    }
    const payment = unb64(sigHeader);
    const intent = toIntent(payment.payload.intent);
    if (ethers.getAddress(intent.payee) !== ethers.getAddress(item.payTo) || intent.amount !== item.price) {
      return json(res, 402, { error: 'payment does not match the quoted price/payTo' });
    }
    const check = await onchainCheck(intent, payment.payload.signature);
    if (!check.isValid) {
      return json(res, 402, { error: 'blocked by onchain policy', reason: check.reason, remainingDaily: check.remainingDaily });
    }
    const settleRes = await fetch(`http://127.0.0.1:${CFG.port}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { intent: payment.payload.intent, signature: payment.payload.signature } }),
    });
    const settled = await settleRes.json();
    if (!settled.success) return json(res, 402, { error: 'settlement failed: ' + settled.error, reason: settled.error });
    const receipt = { success: true, txHash: settled.txHash, network: `eip155:${CFG.chainId}`, explorer: settled.explorer };
    return json(
      res,
      200,
      {
        symbol: 'AVAX/USDC',
        price: '35.41',
        change24h: '+1.8%',
        timestamp: new Date().toISOString(),
        source: 'AgentGuard402 demo feed',
        paidWith: { txHash: settled.txHash, policyId: intent.policyId.toString(), amount: intent.amount.toString() },
      },
      { 'x-payment-response': b64(receipt) }
    );
  }

  json(res, 404, { error: 'not found', route });
}

function sendFile(res, p) {
  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found: ' + p);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[error]', e);
    try {
      json(res, 500, { error: e.message });
    } catch {
      /* ignore */
    }
  });
});

server.listen(CFG.port, () => {
  console.log(`AgentGuard402 facilitator/listener on http://127.0.0.1:${CFG.port}`);
  console.log(`chain ${CFG.chainId} | vault ${CFG.vault} | registry ${CFG.registry} | token ${CFG.usdc}`);
  console.log(`facilitator ${facilitator ? facilitator.address : '(未配置)'} | x402 spec https://docs.x402.org`);
  if (!CFG.vault || !CFG.registry) console.log('! 还没部署合约或 .env 里地址为空, 先跑 setup-keys.js + Deploy');
});
