/**
 * AgentGuard402 - 自主支付 Agent 客户端
 *
 * 这个文件扮演"AI Agent"：它自己决定要不要买数据，自己签名付款，
 * 手里不持有任何代币，也不需要一分钱 gas。
 * 每一步都先问 facilitator "这笔能不能过"，被拦就如实记原因。
 *
 * 单独跑:  node agent.js            (读 .env, 跑一轮完整演示)
 * 被服务端调用: require('./agent.js')
 */
const { ethers } = require('ethers');

const INTENT_TYPES = {
  PaymentIntent: [
    { name: 'policyId', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'resourceId', type: 'bytes32' },
  ],
};

function createAgent(opts) {
  const provider = new ethers.JsonRpcProvider(opts.rpc, opts.chainId);
  const wallet = new ethers.Wallet(opts.agentPrivateKey, provider);
  const base = opts.baseUrl || 'http://127.0.0.1:4020';

  async function getChallenge(url) {
    const res = await fetch(base + url);
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const header = res.headers.get('payment-required');
    const envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return envelope.accepts[0];
  }

  /** 买一次：402 -> 预检 -> 签名 -> 带签名重试 -> 拿到数据 */
  async function buy(url, policyId) {
    const started = Date.now();
    const accept = await getChallenge(url);
    const intent = {
      policyId: BigInt(policyId),
      payee: accept.payTo,
      amount: BigInt(accept.maxAmountRequired),
      nonce: BigInt('0x' + require('crypto').randomBytes(16).toString('hex')),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
      resourceId: ethers.id(url),
    };

    // 1) 签名前先预检: 链上策略说这钱能不能花 (facilitator 会 eth_call 我们的合约)
    const pre = await postJson(base + '/verify', {
      accepts: accept,
      payload: { intent: serializeIntent(intent), signature: null },
    });
    if (!pre.isValid) {
      return {
        url,
        ok: false,
        stage: 'precheck',
        reason: pre.reason,
        blocked: true,
        ms: Date.now() - started,
      };
    }

    // 2) Agent 用私钥签 EIP-712 付款意图 (不需要 gas, 不需要持币)
    const signature = await wallet.signTypedData(
      { name: 'AgentGuard402', version: '1', chainId: opts.chainId, verifyingContract: opts.vault },
      INTENT_TYPES,
      {
        policyId: intent.policyId,
        payee: intent.payee,
        amount: intent.amount,
        nonce: intent.nonce,
        deadline: intent.deadline,
        resourceId: intent.resourceId,
      }
    );

    // 3) 带签名重试 -> facilitator 上链结算
    const payment = { x402Version: 2, scheme: accept.scheme, network: accept.network, payload: { intent: serializeIntent(intent), signature } };
    const res = await fetch(base + url, {
      headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      return { url, ok: false, stage: 'settle', reason: body.error || `HTTP ${res.status}`, blocked: true, ms: Date.now() - started };
    }
    const receipt = JSON.parse(Buffer.from(res.headers.get('x-payment-response') || '', 'base64').toString('utf8'));
    return { url, ok: true, data: body, txHash: receipt.txHash, explorer: receipt.explorer, ms: Date.now() - started };
  }

  return { address: wallet.address, buy, getChallenge };
}

function serializeIntent(i) {
  return {
    policyId: i.policyId.toString(),
    payee: i.payee,
    amount: i.amount.toString(),
    nonce: i.nonce.toString(),
    deadline: i.deadline.toString(),
    resourceId: i.resourceId,
  };
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// ---------- 命令行模式: 跑一轮完整演示 ----------
if (require.main === module) {
  const path = require('path');
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const agent = createAgent({
    rpc: process.env.RPC_URL,
    chainId: Number(process.env.CHAIN_ID),
    vault: process.env.VAULT,
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY,
    baseUrl: `http://127.0.0.1:${process.env.PORT || 4020}`,
  });
  (async () => {
    console.log('agent address:', agent.address, '(无 gas, 不持币)');
    for (const [url, label] of [
      ['/api/premium/market-data', '正常采购 1'],
      ['/api/premium/market-data', '正常采购 2'],
      ['/api/premium/bulk-dataset', '超单笔上限'],
      ['/api/premium/scam-feed', '未授权收款人'],
    ]) {
      const r = await agent.buy(url, process.env.POLICY_ID || 1);
      console.log(label.padEnd(16), r.ok ? 'PASS  tx=' + r.txHash : 'BLOCKED  ' + r.reason, `(${r.ms}ms)`);
    }
  })();
}

module.exports = { createAgent };
