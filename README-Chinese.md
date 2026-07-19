# A2API

Agent-to-API 协议与 MVP Demo：生成简单任务 UI，**调通 APIJSON 请求**，之后用户通过界面改筛选 / 排序 / 分页即可再次调用 APIJSON（HTTP），**不再经过 LLM**。

不走 SQL 执行路径。**敏感写操作**（默认 `delete`）进入 Admin 审批队列；**其它写操作**自动执行，并在后台留下 `auto_approved` 审批记录。

英文文档：[README.md](./README.md)

## 环境要求

- Node.js 18+
- 本地 [APIJSONBoot-MultiDataSource](https://github.com/APIJSON/APIJSON-Demo)（或兼容服务）运行在 `http://localhost:8080`

## 快速开始

```bash
cd ~/a2api
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- 客户端（Vite）：http://localhost:5173  
- API（Hono）：http://localhost:3000  

打开客户端地址。右上角 **Login** 可登录/注册，并配置 **AI Model / Base URL / API Key**（参考 APIAuto）。可点快捷芯片（例如 **List the latest 3 moments with authors**），再改排序/分页并点击 **Query / Refresh** —— 右侧会显示 `usedLlm: false` 以及实际发出的 APIJSON 请求体。

对话示例见 [`conversations/`](./conversations/)；项目 Agent skills 见 [`.cursor/skills/`](./.cursor/skills/)。

可选：在 `.env` 中设置 `OPENAI_API_KEY`，用 LLM 辅助 Bootstrap。未配置时，内置意图规则仍可识别 User / Moment / Comment（中英文说法均可）。

## 仓库结构

| 路径 | 作用 |
|------|------|
| `packages/protocol` | A2API 0.1 信封、JSON Pointer、校验器、CRUD 夹具测试 |
| `packages/runtime` | `ApiJsonClient`、`HitlController`、`BoundExecutor` |
| `apps/chat-demo` | 编排器 + 聊天 UI（Bootstrap）+ 绑定筛选（稳态） |

## 协议（MVP）

信封格式：`{ "version": "0.1", "<type>": { ... } }`

- `proposeRequest` — 候选 APIJSON 调用  
- `reviseRequest` / `decision` — 修改 / 批准|拒绝  
- `bindRequest` — `code == 200` 后，产出模板 + `paramMap` 供 UI 驱动调用  
- `requestResult` / `status` — 结果与状态  

读操作自动执行。非敏感的 `post` / `put` 自动执行并写审计记录。敏感方法（默认 `delete`，可用 `SENSITIVE_METHODS` 覆盖）需在 **Admin** 页签批准/拒绝。

## 两阶段体验

1. **Bootstrap（聊天 / AI 或规则）** — 生成 UI + 提出 APIJSON → 校验 → 执行至成功 → 发出 `bindRequest`  
2. **稳态（无 LLM）** — 筛选/排序/分页 → `BoundExecutor` 将 `paramMap` 合并进 `bodyTemplate` → `POST {baseUrl}/{method}`  

## UI | Data 页签

顶部页签：

- **UI** — 聊天 Bootstrap + 绑定表格 / 详情 / 图表  
- **Data** — 类 APIAuto HTTP 调试  
- **Admin** — 敏感操作审批队列 + 审计（含自动通过记录）  

另外：

- **Embed APIAuto** — iframe 打开 `http://localhost:8080/api/index.html?send=true&type=JSON&url=...&json=...`（分享链接自动填充并发送）  
- **Open APIAuto in new window** — 同一分享链接在新标签打开  

Agent / 控制台自动化：

```js
a2apiAgent.switchTab("data")
a2apiAgent.debug({
  url: "http://localhost:8080/get",
  json: { User: { id: 38710 } },
  send: true,          // 内置发送
  // useApiAuto: true, // 或加载 iframe 并自动发送
})
```

## 配置 APIJSON

```bash
export APIJSON_BASE_URL=http://localhost:8080
# 或编辑 .env
```

请确保 Demo 库表（User / Moment / Comment）在该服务上可用。

**写操作（POST/PUT/DELETE）：** Demo 常要求已登录会话（`@role` OWNER/LOGIN）。MVP 仍会生成请求并展示 HITL 批准/拒绝界面；若 APIJSON 返回未登录，请通过 Demo/APIAuto 会话 Cookie 登录，或在本地放宽 Access。**读操作**可直接使用公开 Demo 数据。

## 脚本

```bash
npm test          # protocol + runtime 单元测试
npm run build     # 编译 packages + demo
npm run dev       # API :3000 + Vite :5173
npm run typecheck
```

## 二期（不在本 MVP）

版本化快照（复用 / 自动调整 / 手动调整）、本地优先存储、跨设备同步（APIJSON 表或文件导入导出）——见设计方案。
