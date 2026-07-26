# 改个排序还要再问 AI？A2API：调通一次，筛选分页零 Token（已开源）

> [English](./ai-data-ops-reliability-a2api.en.md)

> AI 生成一次 UI 与请求，之后筛选 / 排序 / 分页直连 HTTP API——安全、快速、稳定，不再绕大模型。

---

## 先说痛点：AI「会查数据」，不等于「能稳定操作数据」

让 Agent 用自然语言列出「最新 3 条动态及作者」，今天已经不难。难的是下一步：

- 用户改一下排序方向  
- 加一个关键词筛选  
- 翻到第 2 页  
- 再点一次刷新

多数方案会把整段意图再丢回 LLM：重新规划、重新 function call、重新拼请求体。结果是：


| 问题    | 表现                   |
| ----- | -------------------- |
| **贵** | 每次 UI 微调都烧 Token     |
| **慢** | 每次交互都等模型往返           |
| **飘** | 同样操作，请求体可能不一样        |
| **险** | 写操作（尤其删除）难审批、难审计、难复现 |


另一条常见路是 Text-to-SQL：演示很炫，上线很慌——SQL 能力边界太大，沙箱、权限、多租户稍有疏漏就是事故。

**真正缺的不是「更会聊天的 Agent」，而是一条把「探索」和「日常操作」拆开的路径：**

1. 用 AI（或规则）**调通一次**可用的 API 请求
2. 把请求**绑定**到任务 UI
3. 之后用户改条件，**直接打 HTTP**，不再经过 LLM

这就是 [A2API](https://github.com/) 要解决的事——**AI 操作数据的可靠性问题**，而不是再做一个「会说话的查数机器人」。

---



## 背景：三股浪潮撞在一起，中间却空了一块


| 浪潮                                 | 解决了什么                | 还没解决什么              |
| ---------------------------------- | -------------------- | ------------------- |
| **LLM Tool Calling / Agent**       | 自然语言 → 行动            | 后续每一次点击仍要过模型        |
| **APIJSON 等 JSON ORM / HTTP CRUD** | 结构化、可控的增删改查，不必手写一堆接口 | 请求体仍多靠人写、人调         |
| **A2UI 式任务 UI 生成**                 | Agent 能拉起表格、表单、图表    | UI 若没有可复用的请求绑定，仍然脆弱 |


A2API 站在这个交叉点：不是「数据库上再盖一层聊天」，而是一套 **Agent-to-API 协议 + 运行时 + MVP Demo**——把一次成功的 APIJSON 调用固化成 `bodyTemplate` + `paramMap`，由 `BoundExecutor` 在稳态阶段直接发 HTTP，右侧可看到 `usedLlm: false`。

一句话对齐项目定位：

**AI 生成一次 UI，API 每次都安全、快速、稳定执行。**

---



## 和已有方案比：优缺点说清楚，价值才站得住



### 1. 「全程 LLM」的聊天 Agent / Function Calling

**优点：** 探索灵活，Demo 好看。  

**缺点：** 翻页、排序不该再推理一轮；结果难复现；成本随点击涨，不随业务价值涨。  

**A2API：** Bootstrap 可以用模型（也可以用内置意图规则）；**稳态不用模型。**

---



### 2. Text-to-SQL / NL2SQL

**优点：** 直达数据，分析师心智模型熟悉。  

**缺点：** SQL 杀伤半径大；方言与 schema 耦合重；权限与租户易漏；改条件往往还要再过一遍 LLM。  

**A2API：** Agent 提议的是 **HTTP 上的 APIJSON**，不是临场拼 SQL；项目明确**不走 SQL 执行路径**。

---



### 3. MCP 等工具发现协议

**优点：** 标准暴露工具，生态强。  

**缺点：** 擅长「让 Agent 找到并调用工具」，并不自动解决「**UI 绑定成功请求后，不再经过模型**」这条稳态路径。  

**A2API：** 补的是中间层生命周期——**propose → revise → decide → bind → re-execute**，信封协议可复用。

---



### 4. Retool 类低代码 / 内部工具

**优点：** 绑定成熟、权限与运维完善。  

**缺点：** Bootstrap 探索期靠工程时间，不靠自然语言；Agent 多为后挂；很少有「Agent 生成 → 审批 → 绑定」的开放协议。  

**A2API：** 聊天（或规则）同时拉起任务 UI **和** 可用请求；绑定是一等公民，不是一次性脚本。

---



### 5. 只用 APIJSON + APIAuto

**优点：** APIJSON 强、APIAuto 调试体验好。  

**缺点：** 缺 Agent 协议层；没有标准的 propose / bind；没有「对话调通 → 稳态零 Token」闭环。  

**A2API：** 站在 APIJSON 之上，补协议、HITL 与 Bound 执行；Demo 还能嵌入 APIAuto，人和 Agent 看同一请求面。

---



## 对照一览


| 维度             | 聊天 Agent + 工具 | Text-to-SQL | 低代码 | 仅 APIJSON | **A2API**  |
| -------------- | ------------- | ----------- | --- | --------- | ---------- |
| 自然语言冷启动        | 强             | 强           | 弱   | 弱         | **强**      |
| 稳态不经 LLM       | 少见            | 少见          | 原生  | 原生（手写）    | **原生（绑定）** |
| 避免 Agent 写 SQL | 看实现           | 否           | 是   | 是         | **是**      |
| 可复用请求绑定        | 临时            | 弱           | 强   | 手写        | **协议级**    |
| 敏感写 HITL       | 自建            | 自建          | 产品化 | 自建        | **内置**     |
| 开放协议 + 运行时     | 部分            | 部分          | 封闭  | 仅 API     | **开源**     |


---



## A2API 怎么做：两阶段，而不是「永远聊天」



### Bootstrap（探索期）

聊天 / AI 或意图规则 → 生成简单任务 UI + 候选 APIJSON → 校验 → 执行到成功（`code == 200`）→ 发出 `bindRequest`（模板 + `paramMap`）。

### Steady-state（稳态）

用户改筛选 / 排序 / 分页 → `BoundExecutor` 合并参数 → `POST {baseUrl}/{method}` → **不调用大模型，不费 Token**。

### 治理（可靠性的另一半）

- **读**：自动执行  
- **非敏感写**（默认 `post` / `put`）：自动执行，并记 `auto_approved` 审计  
- **敏感方法**（默认 `delete`，可配）：进 **Admin** 审批队列

该拦的拦，该快的快——不是每个列表刷新都弹一次「是否批准」。

---



## 亮点：为什么这套组合值得打开仓库

1. **智能用在不确定处，HTTP 用在必须确定处**——「该调什么」可以推理；「同样条件再调一次」必须可复现。
2. `bindRequest` **是协议产物，不是 Demo 凑巧**——别的运行时可以只实现信封，不必抄聊天 UI。
3. **比 NL2SQL 更贴生产边界**——结构化 JSON + 既有 Access / Request 规则，而不是 Agent 现场发明 SQL。
4. **第一次成功之后，成本与延迟断崖下降**——稳态就是普通 API 调用，才撑得住「下午一直开着」的内部工具。
5. **默认可审计**——可展示真实 APIJSON 体与 `usedLlm: false`；敏感与自动通过写操作都有轨迹。
6. **MVP 能跑**——对接 [APIJSON Demo](https://github.com/APIJSON/APIJSON-Demo)：列表/关联、图表、详情、Data 调试、Admin 队列；无 Key 时规则仍覆盖常见 User / Moment / Comment 意图。

---



## 谁该关注

- `想把` Agent 从「酷 Demo」做成「每天真用」的产品团队  
- 已有 APIJSON / 内部 HTTP 平台、想加 Agent 前门又不想丢控制权的团队  
- 希望读与提议可加速、破坏性写必须审批的安全敏感场景  
- 研究 Tool Calling 与「UI–API 持久绑定」之间缺口的协议设计者

---



## 快速上手

```bash
cd ~/a2api   # 或 clone 后进入仓库
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- 客户端：[http://localhost:5173](http://localhost:5173)  
- API：[http://localhost:3000](http://localhost:3000)  
- APIJSON Demo（或兼容服务）：[http://localhost:8080](http://localhost:8080)

点芯片如 **List the latest 3 moments with authors**，改排序或分页再点 **Query / Refresh**——右侧应出现 `usedLlm: false` 与真实 APIJSON 请求体。

可选：账号菜单配置 AI Model / Base URL / API Key，或在 `.env` 设 `OPENAI_API_KEY` 增强 Bootstrap；不配也能靠内置规则跑通常见意图。

---


## 一句话

多数「AI + 数据」栈，在难题已经解开之后，仍把 LLM 留在每次点击上。  

**A2API 把模型当成 Bootstrap 发动机：调通一次可绑定、可审计的 APIJSON 请求，然后把日常操作还给 HTTP。**

厌倦为改排序付 Token，或担心 Agent 写 SQL——欢迎试用、提 Issue、一起把这条协议走实。

**调通一次。绑定留下。调用不再经过 LLM。**