# A2API：让 Agent 调通一次 API——然后让开

**开源 · Agent-to-API 协议 · 可控的 APIJSON CRUD，配上可复用的 UI 绑定**

> [English](./a2api-agent-to-api-announcement.en.md)

---

## 那个一直没被说透的问题

AI Agent 已经越来越会**跟系统对话**。但要让它们**稳定地操作系统**，仍然意外地差。

让 Agent「列出最新动态及作者」，它能起草查询、调用工具、渲染表格。但让同一个 Agent——或同一个用户——改排序、加关键词筛选、翻到第 2 页，多数栈又会做昂贵的事：把整段意图再丢回 LLM，重新规划 tool call，再指望模型吐出形状一致的请求体。

这个循环带来四个实际失败：

1. **贵** —— 每次 UI 微调都烧 Token  
2. **慢** —— 每次交互都等模型往返  
3. **飘** —— 同样的筛选变更，可能拼出不一样的请求体  
4. **险** —— 写操作（尤其删除）难门禁、难审计、难审批  

与此同时，另一类方案走向反面：Text-to-SQL，或「干脆让模型写数据库查询」。演示里像魔法，生产里像噩梦——SQL 能力太强、难沙箱，也很少是你希望 Agent 在每次点击时现场发明的东西。

**A2API** 从另一个前提出发：

> 用 Agent（或规则）**发现并验证**一次可用的 API 请求。  
> 然后把该请求**绑定**到简单的任务 UI，使筛选 / 排序 / 分页变更直接打 API——**不再经过 LLM**。

没有 SQL 执行路径。真实 HTTP。确定性重执行。该人工把关的地方才把关。

---

## 背景：我们怎么走到这里

三股浪潮撞在一起：

| 浪潮 | 解决了什么 | 还没解决什么 |
|------|------------|--------------|
| **LLM Tool Calling / Agent** | 自然语言 → 行动 | 每一次后续操作仍要过模型 |
| **API-first 后端与 JSON ORM**（如 [APIJSON](https://github.com/Tencent/APIJSON)） | 声明式、结构化的 HTTP CRUD，不必手写一堆接口 | 人仍要手写、手调 JSON |
| **生成式任务 UI**（A2UI 一类思路） | Agent 能拉起表格、表单、图表 | UI 若没有可复用、已校验的请求绑定，仍然脆弱 |

A2API 站在这个交叉点。它不是「数据库上再盖一层聊天机器人」，而是一套精简的 **Agent-to-API 协议**，加上运行时与 MVP Demo：把一次成功的 APIJSON 调用固化成**绑定**交互——模板 + `paramMap` → `BoundExecutor` → HTTP，稳态路径上可以看到 `usedLlm: false`。

---

## 已有方案——以及它们差在哪

### 1. 全程 LLM 的 Agent（Function Calling / ReAct /「工具上聊天」）

**优点：** 灵活。适合探索。Demo 好看。

**对日常数据工作的弱点：**

- 分页和排序不该再走一轮推理  
- 刷新之间结果不确定  
- Token 成本随 UI 交互涨，不随业务价值涨  
- 很难证明「明天还会跑出完全一样的请求」

**A2API 对照：** Bootstrap 可以用 LLM（也可以用内置意图规则）。稳态不用。

---

### 2. Text-to-SQL / NL2SQL 副驾驶

**优点：** 直达数据；分析师心智模型熟悉。

**弱点：**

- 对 Agent 而言，SQL 是高杀伤半径语言  
- Schema 耦合与方言差异主导失败模式  
- 安全、租户、角色校验很容易漏  
- 改写条件通常仍绑定 LLM

**A2API 对照：** Agent 提议的是 **HTTP 上的 APIJSON**，不是 SQL。访问控制与请求结构留在你已经信任（或可以收紧）的 API 层。项目明确不走 SQL 执行路径。

---

### 3. MCP 与工具发现协议

**优点：** 以标准方式向 Agent 暴露工具，生态势头强。

**相对本问题的弱点：**

- MCP 帮 Agent **找到并调用**工具；本身并不解决 **UI 绑定后的无模型重执行**  
- 发现之后，你仍需要一种模式：「冻结成功调用、参数化，再让 UI 驱动它」

**A2API 对照：** 互补心态。A2API 聚焦缺失的中间层：**propose → revise → decide → bind → re-execute**，信封协议为这条生命周期而设计。

---

### 4. 低代码 / 内部工具（Retool 一类）

**优点：** UI 绑定成熟，权限与运维打磨到位。

**弱点：**

- Bootstrap 靠工程时间，不靠自然语言  
- Agent 多为后挂，甚至没有  
- 很少有可移植协议，承载「Agent 生成 → 审批 → 绑定」的请求

**A2API 对照：** 聊天（或规则）同时冷启动任务 UI **和** 可用的 APIJSON 请求；绑定是一等公民，不是一次性定制脚本。

---

### 5. 只用 APIJSON + APIAuto

**优点：** APIJSON 是强大的、少写代码的 HTTP JSON ORM。APIAuto 是该世界里强力的调试器。

**没有 Agent 层时的弱点：**

- 仍要有人写出正确的请求体  
- 没有标准的 propose / revise / bind 信封  
- 没有内置的「对话 → 可用 UI → 无 LLM 刷新」闭环

**A2API 对照：** 站在 APIJSON 的肩膀上，补上 Agent 协议、HITL 与绑定执行。Demo 甚至嵌入 APIAuto 供检视——Agent 与人共享同一请求面。

---

## A2API 究竟是什么

A2API 是一个开源 monorepo，分三层：

| 部分 | 角色 |
|------|------|
| **`packages/protocol`** | A2API 0.1 信封：`proposeRequest`、`reviseRequest`、`decision`、`bindRequest`、`requestResult`、`status` |
| **`packages/runtime`** | `ApiJsonClient`、`HitlController`、`BoundExecutor` |
| **`apps/chat-demo`** | 聊天冷启动 + 稳态表格/详情/图表 + Data 调试器 + Admin 审批 |

### 两阶段 UX（核心想法）

1. **Bootstrap** —— 聊天 / AI 或意图规则生成简单任务 UI 与候选 APIJSON 调用。校验并执行，直到 `code == 200`。发出 `bindRequest`（请求体模板 + `paramMap`）。  
2. **Steady-state** —— 用户改筛选、排序、分页。`BoundExecutor` 把参数合并进模板，再 `POST` 到 `{baseUrl}/{method}`。**没有 LLM。**

### 与真实后端匹配的治理

- **读** 自动执行  
- **非敏感写**（默认 `post` / `put`）自动执行，并记一条 `auto_approved` 审计  
- **敏感方法**（默认 `delete`，可配）进入 **Admin** 的 Approve / Reject 队列

这是杀伤半径大时才上的人机协同——不是每个无害的列表刷新都弹一次确认框。

---

## 为什么这套组合是亮点

### 1. Agent 负责发现；HTTP 负责操作

不确定高的地方用智能（该调什么？）。不确定应为零的地方用确定性 HTTP（同样筛选 → 同样请求）。

### 2. 绑定是协议产物，不是 Demo 凑巧

`bindRequest` 是一等信封。别的运行时可以实现同一生命周期，不必抄聊天 UI。

### 3. 比 NL2SQL 更安全的表面

APIJSON 请求仍是结构化 JSON，走受控端点。Agent 不是为每次点击发明临时 SQL 字符串。

### 4. 第一次成功之后，成本与延迟断崖下降

稳态交互就是普通 API 调用。这样「AI 辅助的数据应用」才撑得住——人们会下午一直开着它。

### 5. 默认可审计

你可以展示精确的 APIJSON 请求体（Demo 里 `usedLlm: false`），并为敏感写与自动通过写保留审批轨迹。

### 6. 实用 MVP，不是 PPT

今天就能对接 [APIJSON Demo](https://github.com/APIJSON/APIJSON-Demo)：列表/关联查询、图表、详情智能字段、Data 页调试、Admin 队列——有无 API Key 都行（规则仍覆盖常见的 User / Moment / Comment 意图）。

---

## 对照一览

| 维度 | 聊天 Agent + 工具 | Text-to-SQL | 低代码构建器 | 仅 APIJSON | **A2API** |
|------|-------------------|------------|--------------|------------|-----------|
| 自然语言冷启动 | 强 | 强 | 弱 | 弱 | **强** |
| 稳态不经 LLM | 少见 | 少见 | 原生 | 原生（手写） | **原生（绑定）** |
| 避免 Agent 写 SQL | 看实现 | 否 | 是 | 是 | **是** |
| 可复用请求绑定 | 临时 | 弱 | 强 | 手写 | **协议级** |
| 敏感写 HITL | 自建 | 自建 | 产品化 | 自建 | **内置** |
| 开放协议 + 运行时 | 部分 | 部分 | 封闭 | 仅 API | **是（开源）** |

---

## 谁该关注

- **做 Agent 产品的团队**——需要从「酷 Demo」毕业成「每天真用的工具」  
- **APIJSON / 内部平台建设者**——想要 Agent 前门，又不想放弃控制权  
- **安全敏感组织**——希望 LLM 帮读和提议，但对破坏性写保留审批门禁  
- **研究者与协议设计者**——在探索 Tool Calling 与可复用 UI–API 绑定之间的缺口  

---

## 快速上手

```bash
git clone <your-repo-url> a2api
cd a2api
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- 客户端：`http://localhost:5173`  
- API：`http://localhost:3000`  
- APIJSON Demo（或兼容服务）：`http://localhost:8080`

试一试芯片如 **「List the latest 3 moments with authors」**，改排序或分页，点 **Query / Refresh**，看右侧稳态调用出现 `usedLlm: false` 与精确的 APIJSON 请求体。

可选：在账号菜单（或 `OPENAI_API_KEY`）配置模型 / Base URL / API Key，以增强 Bootstrap。没有 Key 时，内置意图规则仍然可用。

---

## 下一步

MVP 证明了这条闭环。Phase 2 瞄准版本化快照（复用 / 自动调整 / 手动调整）、本地优先存储与跨设备同步——让绑定请求变成可复用、可分享的工作单元，而不只是单次会话的奇迹。

---

## 一句话

多数「AI + 数据」栈，在难题已经解开之后，仍把模型留在关键路径上。  
**A2API** 把 LLM 当成 Bootstrap 发动机：为一次**可用、已绑定、可审计的 APIJSON 请求**服务——然后让用户与 UI 以 API 速度操作该请求。

如果你厌倦为改排序列付 Token，或担心 Agent 写 SQL，这是值得关注——也值得亲自试——的开源方向。

**A2API：提议一次。绑定留下。调用不再经过 LLM。**
