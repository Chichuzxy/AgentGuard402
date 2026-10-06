# AgentGuard402 - 给 x402 机器支付加一层链上策略护栏

**一句话**: x402 让 AI Agent 能自己付钱, 但管不住它付给谁、付多少。我们在结算前用智能合约强制校验额度与收款白名单, Agent 全程不持币、只签名。

**重点**: 已部署在 Avalanche Fuji 测试网, 有真实交易可验证 (见下方"链上证据")。

**在线演示**: https://contributed-quiet-fireplace-henry.trycloudflare.com

---

## 1. 要解决的问题

x402 是"付费才能访问资源"的 HTTP 协议: 客户端拿到 `402 Payment Required` 后付款、带凭证重试, 服务方放行。

它的优点是简单。问题也在这: **协议本身没有状态**。x402 官方文档明确写着它不处理订阅、计量、退款、条件放行 —— 这些都要应用自己在链上解决。

于是出现一个真实风险:

- Agent 一旦拿到支付能力, 就等于拿到一张没有额度的卡
- 服务方无法区分"这笔钱是哪个 Agent 按哪条规则花的"
- 出了事没有可审计的链上记录

我们要补的就是这块空白: **结算之前的链上策略强制**。

## 2. 方案

三层结构, 钱和规则都放在链上:

| 组件 | 作用 |
|---|---|
| `MockUSDC3009` | 带 EIP-3009 `transferWithAuthorization` 的测试稳定币, 接口对齐 Avalanche C-Chain 上的 USDC |
| `AgentPolicyRegistry` | 策略登记处: 单笔上限 / 每日上限 / 收款白名单 / 到期时间 / 停用 / 换 Agent |
| `PolicyVault` | 资金托管。`checkPayment` 预览和 `settle` 执行走**同一份判断逻辑**, 只有策略 owner 能提款 |

一轮支付的实际流程:

```
Agent            服务方(402)          Facilitator           PolicyVault
  |  请求资源  ->    |                     |                    |
  |  <- 402 挑战     |                     |                    |
  |  签 EIP-712 支付意图 (不花 gas)  ->     |                    |
  |                  |   提交 settle  ->   |  校验: 额度/白名单/   |
  |                  |                     |  到期/nonce/签名  ->  |
  |                  |                     |  <- 通过: 转账给收款人 |
  |                  |                     |  <- 不通过: 整笔回滚   |
  |  <- 拿到资源                          |                    |
```

三个角色分离:

- **Agent**: 只有签名权, 不持有任何代币, 也不需要 AVAX 付 gas
- **Facilitator**: 只负责把交易提交上链, 没有任何提权函数能动 vault 里的钱
- **Owner**: 出钱方, 建策略、注资、可随时冻结或提走

## 3. 为什么是 Avalanche

- x402 官方支持网络表里明确包含 Avalanche C-Chain (`eip155:43114`, USDC, EIP-3009), 不是硬蹭
- C-Chain 的 USDC 原生支持 EIP-3009 授权转账, 和我们的 `MockUSDC3009` 是同一套接口, 从测试网换到主网只需要换 token 地址
- 出块快、gas 便宜, 适合高频小额机器支付场景

## 4. 链上证据 (Avalanche Fuji, chainId 43113)

### 合约地址

| 合约 | 地址 |
|---|---|
| AgentPolicyRegistry | `0xA79b564BcB53fab8B218C6707d815585338b6E6C` |
| PolicyVault | `0xa3Bd7fA57d21fbCC0583bF790F6B4bEdDc2E472B` |
| MockUSDC3009 | `0x8a50f20700ea53192e51f94030357DE8c515EA7E` |

部署交易:

- Registry: https://testnet.snowtrace.io/tx/0xd212794b272f1d9b66f8a3d9365c2c474d9574589463f4563800c880f072ee54
- Vault: https://testnet.snowtrace.io/tx/0xfd412f0c44b79bf89e0403e9fb5aaa1b9d4a812a2acc4b8214eeee20f6e9c086

### 端到端实测 (真实交易)

一轮完整演示共 16 个场景: **4 笔放行 + 12 笔拦截**, 全部实测可复现。

放行 (Agent 无 gas、无持币, 由 facilitator 代发):

- https://testnet.snowtrace.io/tx/0x417d443b86996234cc79bd0faae6d9106e289479d770ecc829f5ef38838534ba
- https://testnet.snowtrace.io/tx/0x6437ddf3a93f864c1dbb4b2cd47a26f48edba286ecdaadeee0c4c409473ab00e
- https://testnet.snowtrace.io/tx/0xeee300a32b96e64af954a8411ea49b8f6e8fb49fea0745bab66b786d13be561c
- https://testnet.snowtrace.io/tx/0x6d599b9f37d9b034090d2011b8aa1aeb58888a5dd7670afc91eb81b504bb1f8c

拦截 12 笔 —— 全部发生在**预检阶段** (合约判定不通过, 交易根本没发出去, 0 gas):

| 合约返回的拒绝理由 | 含义 |
|---|---|
| `registry: per-tx cap exceeded` | 超过单笔上限 |
| `vault: daily cap exceeded` | 超过每日上限 |
| `registry: payee not in allowlist` | 收款人不在白名单 |
| `registry: amount is zero` | 金额为零 |
| `registry: policy not found` | 策略不存在 |
| `registry: policy expired` | 策略已过期 |
| `registry: policy inactive` | 策略已停用 |
| `vault: insufficient vault balance` | 金库余额不足 |
| `vault: policy frozen` | 资金被冻结 |
| `intent: bad signature` | 别人冒充 Agent 签名 |
| `vault: nonce already used` | 签名被重放 |
| `intent: expired` | 签名本身过期 |

合约单元测试: `forge test` **17 passed / 0 failed**, 覆盖超额度、白名单外、日额度重置、nonce 重放、过期策略、换人签名、改金额、冻结停用、预览与执行一致等场景。

## 5. 目录结构

```
contracts/            Solidity 0.8.20 + Foundry
  src/                MockUSDC3009 / AgentPolicyRegistry / PolicyVault
  test/               forge 测试
  script/Deploy.s.sol 一键部署脚本
backend/              零框架依赖 Node 服务 (原生 http + ethers)
  server.js           x402 握手 + /verify + /settle + 审计流水 + Agent 演示运行器
  agent.js            自主支付 Agent: 402 -> 预检 -> 签 EIP-712 -> 重试 -> 取数据
frontend/index.html   单文件前端 (奶油橙暖色): 建策略 / 注资 / 付款预览 / 一键跑演示 / 审计流水
evidence/             部署与演示的真实输出存档
```

## 6. 本地跑起来

```bash
# 1. 合约
cd contracts
forge test                       # 17 passed
anvil                            # 另开一个终端

# 2. 后端 (另开终端)
cd backend
npm install
node setup-keys.js               # 本地生成测试私钥写入 .env (不打印私钥)
PRIVATE_KEY=0x...(本地生成的测试私钥)  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
node bootstrap-local.js          # 铸币 / 建策略 / 注资
node server.js                   # 打开 http://127.0.0.1:4020

# 3. 跑一轮 Agent 演示 (快速版)
node agent.js

# 3b. 跑完整演示 (16 个场景, 会自动新建一组演示策略)
node agent.js --full
```

切到 Fuji 测试网:

```bash
# 1. contracts/.env 里填部署私钥
#    PRIVATE_KEY=0x...(测试网钱包, 需要有 AVAX 付部署 gas)
cd contracts
forge script script/Deploy.s.sol --rpc-url https://api.avax-test.network/ext/bc/C/rpc --broadcast --slow

# 2. 把新地址同步进后端配置
cd ../backend
node switch-to-fuji.js

# 3. backend/.env 里填 FACILITATOR_PRIVATE_KEY (负责发交易的那个钱包)
node bootstrap-local.js        # 铸币 + 建策略 + 注资 (在 Fuji 上会跳过自动转 gas)
node server.js
```

Fuji 网络参数: RPC `https://api.avax-test.network/ext/bc/C/rpc`, chainId `43113`, 浏览器 `https://testnet.snowtrace.io`。

## 7. 本次 Hackathon 完成范围

按赛事规则要求声明: 本项目的合约、facilitator 服务、Agent、前端均为**本次新写**。唯一复用的是团队既有的 EVM 部署经验。

## 8. 安全说明

- 仓库内所有私钥均为**测试网专用临时钱包**, 不持有任何真实资产
- `.env` 已被 `.gitignore` 排除, 仓库中只有 `.env.example` 模板
- 代码里出现的 `0xac0974bec3...` 是 **anvil (Foundry 本地测试链) 的官方默认账户私钥** ——
  Foundry 文档公开的固定值 (forge-std 自己的测试也在用), 只在本地区块链有效, 不持有任何真实资产
- `PolicyVault` 没有任何函数能让 facilitator 或 agent 提走资金, 提款只认 policy owner
