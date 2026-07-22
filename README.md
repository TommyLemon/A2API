English | [中文](./README-Chinese.md)
# A2API

Chat agent to HTTP API to safely, quickly and stably add, view, edit or remove data in tables, forms or charts together with A2UI. <br />
**AI generate UI once, API repeat everytime safely, quickly and stably.**

Agent-to-API protocol and MVP demo: generate a simple task UI, **tune an APIJSON request until it works**, then let users change filters, sort, and paging from the UI — which calls APIJSON over HTTP **without going through the LLM again**.

No SQL execution path. **Sensitive writes** (default: `delete`) wait in the Admin approval queue; **other writes** auto-execute and leave an `auto_approved` audit record on the server.

![](https://github.com/user-attachments/assets/27928660-ab00-41ec-ad2a-fd318eaeacf5)
![](https://github.com/user-attachments/assets/173aa5ac-84ce-40c3-9453-1d98051585b3)
![](https://github.com/user-attachments/assets/976c2893-2a58-412c-8c14-efa2bfe2e477)

## Requirements

- Node.js 18+
- Local [APIJSONBoot-MultiDataSource](https://github.com/APIJSON/APIJSON-Demo) (or compatible) at `http://localhost:8080`

## Quick start

```bash
cd ~/a2api
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- Client (Vite): http://localhost:5173  
- API (Hono): http://localhost:3000  

Open the client URL. Use **Login** (top-right) to open the account menu and set **AI Model / Base URL / API Key** (APIAuto-style). Try chips such as **List the latest 3 moments with authors**, then change sort/page and click **Query / Refresh** — the right panel shows `usedLlm: false` and the exact APIJSON body.

Curated chat examples live in [`conversations/`](./conversations/); project Agent skills in [`.cursor/skills/`](./.cursor/skills/).

Optional: set `OPENAI_API_KEY` in `.env` to refine bootstrap with an LLM. Without it, built-in intent rules for User / Moment / Comment still work (English and Chinese phrases).

## Monorepo layout

| Path | Role |
|------|------|
| `packages/protocol` | A2API 0.1 envelopes, JSON Pointer helpers, validators, CRUD fixture tests |
| `packages/runtime` | `ApiJsonClient`, `HitlController`, `BoundExecutor` |
| `apps/chat-demo` | Orchestrator + chat UI (Bootstrap) + bound filters (Steady-state) |

## Protocol (MVP)

Envelopes: `{ "version": "0.1", "<type>": { ... } }`

- `proposeRequest` — candidate APIJSON call  
- `reviseRequest` / `decision` — edit / approve|reject  
- `bindRequest` — after `code == 200`, template + `paramMap` for UI-driven calls  
- `requestResult` / `status` — outcomes  

Read methods auto-execute. Non-sensitive `post` / `put` auto-execute with an audit row. Sensitive methods (default `delete`, override `SENSITIVE_METHODS`) wait for **Admin** Approve/Reject.

## Two-phase UX

1. **Bootstrap (chat / AI or rules)** — generate UI + propose APIJSON → validate → execute until success → emit `bindRequest`  
2. **Steady-state (no LLM)** — filter/sort/page → `BoundExecutor` merges `paramMap` into `bodyTemplate` → `POST {baseUrl}/{method}`  

## UI | Data tabs

Top tabs:

- **UI** — chat bootstrap + bound table/detail/charts  
- **Data** — APIAuto-style HTTP debugger  
- **Admin** — sensitive approval queue + audit trail (`auto_approved` / approved / rejected)  

Also:

- **Embed APIAuto** — iframe `http://localhost:8080/api/index.html?send=true&type=JSON&url=...&json=...` (share-link auto fill + send)  
- **Open APIAuto in new window** — same share URL in a new tab  

Agent / console automation:

```js
a2apiAgent.switchTab("data")
a2apiAgent.debug({
  url: "http://localhost:8080/get",
  json: { User: { id: 38710 } },
  send: true,          // builtin send
  // useApiAuto: true, // or load iframe + auto send
})
```

## Configure APIJSON

```bash
export APIJSON_BASE_URL=http://localhost:8080
# or edit .env
```

Ensure the Demo schema (User / Moment / Comment) is available on that server.

**Writes (POST/PUT/DELETE):** the Demo often requires a logged-in session (`@role` OWNER/LOGIN). The MVP still generates the request and shows the HITL Approve/Reject UI; if APIJSON returns "not logged in", log in via your Demo/APIAuto session cookies or relax Access for local testing. **Reads** work out of the box against the public Demo data.

## Scripts

```bash
npm test          # protocol + runtime unit tests
npm run build     # compile packages + demo
npm run dev       # API :3000 + Vite :5173
npm run typecheck
```

## Phase 2 (not in this MVP)

Versioned snapshots (reuse / auto-adjust / manual-adjust), local-first store, cross-device sync via APIJSON tables or file import/export — see the design plan.
