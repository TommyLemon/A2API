---
name: a2api-demo
description: Work on the A2API monorepo (protocol, runtime, chat-demo UI/APIJSON). Use when changing envelopes, BoundExecutor, chat-demo charts/tables/detail, account AI settings, or APIJSON Demo integration.
---

# A2API demo skill

## Layout

- `packages/protocol` — A2API 0.1 envelopes / validators
- `packages/runtime` — `ApiJsonClient`, HITL, `BoundExecutor`
- `apps/chat-demo` — Hono API + Vite client (Bootstrap chat + steady-state UI)
- `apps/admin` — Apply submit/status + `available-requests` (Access∩Request+Document) + approve → Access/Request/Document/Chain then `/post/verify` (TYPE_RELOAD=4) + `/reload`; SPA list/edit via APIJSON; Login/Settings (same chrome as chat-demo); SQL `sql/sys_Apply.sql`, `sql/sys_Call.sql`
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

- Steady-state filter/sort/page must not call the LLM (`usedLlm: false`); client rebuilds the body and calls `/apijson/{method}` (Node BFF) — never absolute `:8080` URLs from bind templates.
- Sensitive writes (default `delete`) go to Admin approval; other writes auto-execute and store `auto_approved` audit rows (`apps/chat-demo/data/approvals.jsonl`).
- Edit/delete: do **not** auto-jump Data API. Always try the API first; on permission / parameter / illegal errors auto-submit Admin Apply. Demo never shows Approve/Reject (Admin only). Refresh polls Apply and notifies only on status change.
- Apply / Request.tag: from page title → lowercase English, spaces→`_`, strip other specials (e.g. `Moment Detail` → `moment_detail`); also set on write body `tag` for retry.
- Chart field pool = all query tables × fields (not table visible-column config).
- User list / primary User: omit `@column` (all fields). JOIN User defaults include `name,tag,head,pictureList` (not only `name`).
- UI copy is i18n via `i18next` in chat-demo (`apps/chat-demo/client/i18n/`) and admin (`apps/admin/client/i18n/`), locales `en` / `zh-CN`; Settings → **UI Language** (reload on change). Both apps share `localStorage` key `a2api.uiLocale`. Separate from **AI Language** (LLM reply language).
- Chinese NLP matching may remain for intent; chat-demo chip `data-msg` follows UI locale.
- Account menu (top-right) holds AI Model / Base URL / API Key; pass as `llm` on `/api/chat` and `/api/analyze`.

## Detail / table smart fields

- Shared smart-image API: `client/smart-image-fields.ts` — table / grid / detail / create **must** use `resolveSmartImageField` / `pickBestImageUrl` (no local re-implement)
- DDL **Show** (`ColumnMeta.show`: Auto / Text / Picture / File) — auto-filled on prompt via `inferColumnShow`; editable in table DDL; drives smart UI
- Evidence (Show=Auto): (1) url + `.jpg`/… or `data:image`; (2) name segments / comment (`头像`…) + url-like
- `sex` / `gender` → Male(0) / Female(1); **Raw** / **Smart** toggle (detail header + table tabs top-right)
- FK: `ColumnMeta.onTable` (Relate Table) + optional `onField` (Relate Field, default `id`). Detail/create/list use `resolveFkRef` (meta overrides auto). `Comment.toId` → self `Comment.id`; do not invent short stems like `toId`→`To`
- FK id-list columns (`contactIdList` / `praiseUserIdList`…): list cells — each id → related **Detail**; `· all` / `+N` → related **List** with `id` IN filter (`onOpenFkList`). Detail smart-mode chips → related **Detail** (`openFkDetail`).
- Detail multi-table: op Add/View/Edit/Remove + table (+ Relate on secondary) → `POST /crud` with `@get`/`@post`/`@put`/`@delete`. Secondary Relate UI: **vice field** + **=|IN|Contains** + Relate table + Relate field → Request.structure `UPDATE` e.g. `"momentId@":"/Moment/id"`, `"id{}@":"/User/contactIdList"`, `"contactIdList<>@":"/Comment/userId"`. Relate refs go in the call body; if the API fails (permission/param/illegal), demo auto-submits **Apply** with structure → Admin approve → Request. Relate also syncs Table DDL (`onTable`/`onField`) via `onRelateSync`. After picking a table, load schema and show all columns (not sparse JOIN `@column`)
- Detail/create: auto-mount verification code under `phone`/`email`; Save attaches body keys in order `"@delete":"Verify"`, `"Verify":{verify}`, then User/… (promote single post/put → crud). Apply structure: Verify first, with `@delete` + `UPDATE.phone@/email@` → owning table
- Detail/create field show/hide: click table name → same list table DDL popover (`ColumnMeta.visible`); left checkbox = show on detail; field row × hides; hidden fields omitted from Save. ▾ next to table name changes table. Schema keys honor logical↔physical aliases (`Privacy` / `apijson_privacy`) so DDL lists all columns, not just `id`
- List / Detail / Create are **independent pages** — titles & surfaceIds must include the kind (`Moment List` / `Moment Detail` / `Create Moment`; `moment_list` / `moment_detail` / `moment_create`). Never collapse both to a bare table name.
- Detail/create header title is an **editable input** (synced with top page selector). Editing the title on detail/create **forks a new saved page** (e.g. Create User → `register`); the previous page is left unchanged. Multi-table slots persist so the new page can be reopened from the top menu.
- Detail header keeps `#` + **id search input** to the right of the title — Enter/blur reloads that record; page title itself does not embed `#id`

## Before finishing

- `npm run typecheck` in `apps/chat-demo` when touching TS
- Apply flow API E2E: `npm run test:e2e -w @a2api/admin`
- Watchable UI E2E (headed browser): `npm run test:ui` — submit → Admin approve/reject → Chat notify
- Prefer editing under the project workspace root after `move_agent_to_root`
