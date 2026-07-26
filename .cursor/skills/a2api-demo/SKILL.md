---
name: a2api-demo
description: Work on the A2API monorepo (protocol, runtime, chat-demo UI/APIJSON). Use when changing envelopes, BoundExecutor, chat-demo charts/tables/detail, account AI settings, or APIJSON Demo integration.
---

# A2API demo skill

## Layout

- `packages/protocol` — A2API 0.1 envelopes / validators
- `packages/runtime` — `ApiJsonClient`, HITL, `BoundExecutor`
- `apps/chat-demo` — Hono API + Vite client (Bootstrap chat + steady-state UI)
- `apps/admin` — Apply submit/status + `available-requests` (Access∩Request+Document) + approve → Access/Request/Document/Chain; SPA list/edit via APIJSON; Login/Settings (same chrome as chat-demo); SQL `sql/sys_Apply.sql`, `sql/sys_Call.sql`
- chat-demo calls admin for permission-gate Apply submit/poll and available request catalog
- `conversations/` — git-managed chat examples
- `.cursor/skills/` — project skills (this file)

## Local run

```bash
cp .env.example .env
npm install && npm run dev
```

- Client http://127.0.0.1:5173 · API http://localhost:3000 · Admin http://127.0.0.1:5174 · APIJSON Demo http://localhost:8080
- Browser APIJSON calls use same-origin `/apijson` → Node BFF (shared JSESSIONID jar); Vite proxies `/apijson` to `:3000`, never straight to Java `:8080`

## Product rules (locked)

- Steady-state filter/sort/page must not call the LLM (`usedLlm: false`).
- Sensitive writes (default `delete`) go to Admin approval; other writes auto-execute and store `auto_approved` audit rows (`apps/chat-demo/data/approvals.jsonl`).
- Edit/delete: do **not** auto-jump Data API. Check Document+Access (`/api/write-gate`): call if allowed, Apply if Document exists without Access; if no Document, try then Apply on permission error. Refresh polls Apply and notifies only on status change.
- Chart field pool = all query tables × fields (not table visible-column config).
- UI copy is English; Chinese NLP matching may remain for intent only.
- Account menu (top-right) holds AI Model / Base URL / API Key; pass as `llm` on `/api/chat` and `/api/analyze`.

## Detail smart fields

- Avatar-like URL fields (`head`, `avatar`, …) → `<img>` + URL input
- `sex` / `gender` → Male(0) / Female(1) select; **Raw** toggle for original values

## Before finishing

- `npm run typecheck` in `apps/chat-demo` when touching TS
- Apply flow API E2E: `npm run test:e2e -w @a2api/admin`
- Watchable UI E2E (headed browser): `npm run test:ui` — submit → Admin approve/reject → Chat notify
- Prefer editing under the project workspace root after `move_agent_to_root`
