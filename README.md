中文 | [English](./README.en.md)

# A2API

用 A2UI 聊天即兴生成 UI 来安全、快速、稳定调用 HTTP API 增删改查表格、表单、图表等数据。<br />
**AI 生成一次 UI，API 每次都安全、快速、稳定执行。**

Agent-to-API 协议、引擎与 Demo：生成任务 UI，之后改筛选/排序/分页直接调用 HTTP API，<br />
**不再调用大语言模型，不费任何 Token**。

不走 SQL 执行路径，**写操作或敏感读操作**自动申请权限，管理员审批通过后才能调通。

![](https://github.com/user-attachments/assets/27928660-ab00-41ec-ad2a-fd318eaeacf5)
![](https://github.com/user-attachments/assets/173aa5ac-84ce-40c3-9453-1d98051585b3)
![](https://github.com/user-attachments/assets/976c2893-2a58-412c-8c14-efa2bfe2e477)
![](https://github.com/user-attachments/assets/7ee60cde-0f06-42db-ac7f-c8c91159b497)
![](https://github.com/user-attachments/assets/7b2da313-4dbf-4eb5-8cd1-5db02256df4e)

## 环境要求

- Node.js 18+
- 本地 [APIJSONBoot-MultiDataSource](https://github.com/APIJSON/APIJSON-Demo/tree/master/APIJSON-Java-Server/APIJSONBoot-MultiDataSource)（或兼容服务）运行在 `http://localhost:8080`

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
- 管理后台（配置审批）：`npm run dev:admin` → http://localhost:5174  
  - 申请表 `Apply`、调用日志表 `Call`：执行 `apps/admin/sql/sys_Apply.sql` 与 `sys_Call.sql` 后重载 Access/Request。
  - 普通增删改查直连 APIJSON HTTP；管理端仅保留「批准写入 Access/Request/Document/Chain」复杂流程  
  - 管理台页签：Apply · Call logs · Stats  




打开客户端地址。右上角 **Login** 可登录/注册，并配置 **AI Model / Base URL / API Key**（参考 APIAuto）。可点快捷芯片（例如 **List the latest 3 moments with authors**），再改排序/分页并点击 **Query / Refresh** —— 右侧会显示 `usedLlm: false` 以及实际发出的 APIJSON 请求体。

对话示例见 [`conversations/`](./conversations/)；项目 Agent skills 见 [`.cursor/skills/`](./.cursor/skills/)。

可选：在 `.env` 中设置 `OPENAI_API_KEY`，用 LLM 辅助 Bootstrap。未配置时，内置意图规则仍可识别 User / Moment / Comment（中英文说法均可）。

## 仓库结构

| 路径 | 作用 |
|------|------|
| `packages/protocol` | A2API 0.1 信封、JSON Pointer、校验器、CRUD 夹具测试 |
| `packages/runtime` | `ApiJsonClient`、`HitlController`、`BoundExecutor` |
| `apps/chat-demo` | 编排器 + 聊天 UI（Bootstrap）+ 绑定筛选（稳态） |
| `apps/admin` | 配置申请审批：批准后写入 Access / Request / Document / Chain |

## 协议（MVP）

信封格式：`{ "version": "0.1", "<type>": { ... } }`

- `proposeRequest` — 候选 APIJSON 调用  
- `reviseRequest` / `decision` — 修改 / 批准|拒绝  
- `bindRequest` — `code == 200` 后，产出模板 + `paramMap` 供 UI 驱动调用  
- `requestResult` / `status` — 结果与状态  

读操作自动执行，敏感方法（默认 `post`,`put`,`delete`,`gets`,`heads`，可用 `SENSITIVE_METHODS` 覆盖）需在 **Admin** 页签批准/拒绝。

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

## 二期

跨设备同步（数据库表或文件导入导出）——见设计方案。

### 关于作者
[https://github.com/TommyLemon](https://github.com/TommyLemon)<br />
![](https://github.com/user-attachments/assets/cef2bd45-b20d-469e-8781-1d647cf0477f)

如果有什么问题或建议可以 [提 Issue](https://github.com/TommyLemon/A2API/issues) 交流技术，分享经验。 <br >
如果你解决了某些 bug，或者新增了一些功能，欢迎 [贡献代码](https://github.com/TommyLemon/A2API/pulls)，感激不尽~ <br >
步骤可参考：https://github.com/Tencent/APIJSON/blob/master/CONTRIBUTING.md#pull-request

### 我要赞赏
创作不易，右上角点亮 ⭐ Star 来收藏/支持下吧，谢谢 ^_^ <br />
https://github.com/TommyLemon/A2API
