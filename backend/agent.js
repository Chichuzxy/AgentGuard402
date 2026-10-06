/**
 * AgentGuard402 - 自主支付 Agent 客户端
 *
 * 这个文件扮演"AI Agent"：它自己决定要不要买数据，自己签名付款，
 * 手里不持有任何代币，也不需要一分钱 gas。
 *
 * 每笔付款走三段:
 *   1) 出 402 报价 -> 无签名预检 (先看策略规则过不过)
 *   2) Agent 签 EIP-712 付款意图
 *   3) 签名后预检 —— facilitator 直接 eth_call 合约 checkPayment (含签名校验)
 *      只有第 3 步也通过, 才真的提交上链。所以被拦的攻击场景一分 gas 都不花。
 *
 * 单独跑:  node agent.js          (快速演示: 3 放行 + 2 拦截)
 *          node agent.js --full   (完整演示: 见 demo-full.js)
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

  const domain = () => ({
    name: 'AgentGuard402',
    version: '1',
    chainId: opts.chainId,
    verifyingContract: opts.vault,
  });

  async function getChallenge(url) {
    const res = await fetch(base + url);
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const header = res.headers.get('payment-required');
    const envelope = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return envelope.accepts[0];
  }

  /** 组装付款意图; opt 可覆盖各字段, 用来构造越权/异常场景 */
  function buildIntent(url, accept, policyId, opt = {}) {
    return {
      policyId: BigInt(policyId),
      payee: opt.payee || accept.payTo,
      amount: opt.amount !== undefined ? BigInt(opt.amount) : BigInt(accept.maxAmountRequired),
      nonce: opt.nonce !== undefined
        ? BigInt(opt.nonce)
        : BigInt('0x' + require('crypto').randomBytes(16).toString('hex')),
      deadline: BigInt(Math.floor(Date.now() / 1000) + (opt.deadlineDelta !== undefined ? opt.deadlineDelta : 60)),
      resourceId: opt.resourceId || ethers.id(url),
    };
  }

  /** 预检: 不传签名只查策略规则, 传签名则走合约 checkPayment 全量校验 */
  async function precheck(accept, intent, signature) {
    return postJson(base + '/verify', {
      accepts: accept,
      payload: { intent: serializeIntent(intent), signature: signature || null },
    });
  }

  async function signIntent(intent, signer) {
    return (signer || wallet).signTypedData(domain(), INTENT_TYPES, {
      policyId: intent.policyId,
      payee: intent.payee,
      amount: intent.amount,
      nonce: intent.nonce,
      deadline: intent.deadline,
      resourceId: intent.resourceId,
    });
  }

  /** 带着签名去请求数据 -> facilitator 上链结算 */
  async function submit(url, accept, payload, started) {
    const payment = { x402Version: 2, scheme: accept.scheme, network: accept.network, payload };
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

  /**
   * 一次完整采购。opt 用来构造越权/异常场景, 正常采购不用传:
   *   signer        换一个钱包签名       -> 演示"冒充 Agent"
   *   deadlineDelta 签名有效期偏移(秒)   -> 负值演示"签名已过期"
   *   amount        覆盖金额             -> 0 演示"金额为零"
   *   replay        复用上一笔的{intent,signature} -> 演示"nonce 重放"
   *   onlySign      只预检+签名不上链     -> 演示脚本取素材用
   */
  async function buyRaw(url, policyId, opt = {}) {
    const started = Date.now();
    const accept = await getChallenge(url);

    if (opt.replay) {
      const pre = await precheck(accept, opt.replay.intent, opt.replay.signature);
      if (!pre.isValid) {
        return { url, ok: false, stage: 'precheck', reason: pre.reason, blocked: true, ms: Date.now() - started };
      }
      return submit(url, accept, { intent: serializeIntent(opt.replay.intent), signature: opt.replay.signature }, started);
    }

    const intent = buildIntent(url, accept, policyId, opt);

    const pre = await precheck(accept, intent, null);
    if (!pre.isValid) {
      return { url, ok: false, stage: 'precheck', reason: pre.reason, blocked: true, ms: Date.now() - started };
    }

    const signature = await signIntent(intent, opt.signer);
    if (opt.onlySign) {
      return { url, ok: true, stage: 'signed', intent, signature, ms: Date.now() - started };
    }

    const pre2 = await precheck(accept, intent, signature);
    if (!pre2.isValid) {
      return {
        url, ok: false, stage: 'precheck', reason: pre2.reason, blocked: true,
        ms: Date.now() - started, intent, signature,
      };
    }

    const r = await submit(url, accept, { intent: serializeIntent(intent), signature }, started);
    return { ...r, intent, signature };
  }

  async function buy(url, policyId) {
    return buyRaw(url, policyId, {});
  }

  return { address: wallet.address, buy, buyRaw, getChallenge, buildIntent, signIntent, precheck };
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


module.exports = { createAgent, loadEnv, serializeIntent };

// ---------- 命令行模式 ----------
function loadEnv() {
  const path = require('path');
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

if (require.main === module) {
  loadEnv();
  if (process.argv.includes('--full')) {
    require('./demo-full.js').runFullDemoCli();
  } else {
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
}

