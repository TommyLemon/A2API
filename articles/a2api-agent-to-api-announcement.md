# A2API: Let Agents Build the API Call Once — Then Get Out of the Way

**Open source · Agent-to-API protocol · Controlled APIJSON CRUD with durable UI bindings**

---

## The problem nobody named clearly enough

AI agents are getting good at *talking* to systems. They are still surprisingly bad at *operating* them.

Ask an agent to “list the latest moments with authors,” and it can draft a query, call a tool, and render a table. Ask the same agent — or the same user — to change the sort order, filter by keyword, or flip to page 2, and most stacks do the expensive thing again: send the whole intent back through the LLM, re-plan a tool call, and hope the model produces the same shape of request.

That loop creates four practical failures:

1. **Cost** — every UI tweak burns tokens
2. **Latency** — every interaction waits on model round-trips
3. **Drift** — the same filter change can produce a different request body
4. **Risk** — write operations (especially deletes) are hard to gate, audit, and approve

Meanwhile, another family of solutions goes the opposite direction: text-to-SQL, or “just let the model write database queries.” That can look magical in demos and terrifying in production — SQL is powerful, hard to sandbox, and rarely what you want an agent inventing on every click.

**A2API** starts from a different premise:

> Use the agent (or rules) to **discover and prove** a working API request once.
> Then **bind** that request to a simple task UI so filter / sort / page changes call the API **without the LLM**.

No SQL execution path. Real HTTP. Deterministic re-execution. Human control where it matters.

---

## Background: how we got here

Three waves collided:

| Wave | What it enabled | What it left unsolved |
|------|------------------|------------------------|
| **LLM tool calling / agents** | Natural-language → actions | Every follow-up still goes through the model |
| **API-first backends & JSON ORMs** (e.g. [APIJSON](https://github.com/Tencent/APIJSON)) | Declarative, structured HTTP CRUD without hand-written endpoints | Humans still author and debug the JSON by hand |
| **Generated task UIs** (A2UI-style ideas) | Agents can spin up tables, forms, charts | UI without a durable, validated request binding is still fragile |

A2API sits at that intersection. It is not “another chatbot on top of your database.” It is a small **Agent-to-API protocol** plus a runtime and MVP demo that turn a successful APIJSON call into a **bound** interaction: template + `paramMap` → `BoundExecutor` → HTTP — with `usedLlm: false` on the steady-state path.

---

## Existing approaches — and where they fall short

### 1. LLM-in-the-loop agents (function calling / ReAct / “chat over tools”)

**Strengths:** Flexible. Great for exploration. Easy to demo.

**Weaknesses for day-to-day data work:**

- Pagination and sorting should not require another reasoning pass
- Results are non-deterministic across refreshes
- Token cost scales with UI interaction, not with business value
- Hard to prove “this exact request will run again tomorrow”

**A2API contrast:** Bootstrap may use an LLM (or built-in intent rules). Steady-state does not.

---

### 2. Text-to-SQL / NL2SQL copilots

**Strengths:** Direct access to data; familiar mental model for analysts.

**Weaknesses:**

- SQL is a high-blast-radius language for agents
- Schema coupling and dialect quirks dominate failure modes
- Security, tenancy, and role checks are easy to get wrong
- Still usually LLM-bound for every reformulation

**A2API contrast:** The agent proposes **APIJSON over HTTP**, not SQL. Access and request structure stay in the API layer you already trust (or can tighten). The project explicitly avoids a SQL execution path.

---

### 3. MCP and tool-discovery protocols

**Strengths:** Excellent for exposing tools to agents in a standard way. Strong ecosystem momentum.

**Weaknesses relative to this problem:**

- MCP helps agents *find and call* tools; it does not by itself solve **UI-bound re-execution without the model**
- After discovery, you still need a pattern for “freeze the successful call, parameterize it, and let the UI drive it”

**A2API contrast:** Complementary mindset. A2API focuses on the missing middle: **propose → revise → decide → bind → re-execute**, with envelopes designed for that lifecycle.

---

### 4. Low-code / internal tools (Retool-class builders)

**Strengths:** Mature UI binding, permissions, ops polish.

**Weaknesses:**

- Bootstrap is engineering time, not natural language
- Agents are bolted on later, if at all
- You rarely get a portable protocol for agent-generated, approved, bound requests

**A2API contrast:** Chat (or rules) bootstraps the task UI *and* the working APIJSON request; the binding is first-class, not a custom one-off.

---

### 5. APIJSON + APIAuto alone

**Strengths:** APIJSON is a powerful, coding-light JSON ORM over HTTP. APIAuto is a strong debugger for that world.

**Weaknesses without an agent layer:**

- Someone still has to author the right body
- No standard envelope for propose / revise / bind
- No built-in “chat → working UI → no-LLM refresh” loop

**A2API contrast:** Stands on APIJSON’s shoulders and adds the agent protocol, HITL, and bound execution. The demo even embeds APIAuto for inspection — agents and humans share the same request surface.

---

## What A2API actually is

A2API is an open-source monorepo with three layers:

| Piece | Role |
|-------|------|
| **`packages/protocol`** | A2API 0.1 envelopes: `proposeRequest`, `reviseRequest`, `decision`, `bindRequest`, `requestResult`, `status` |
| **`packages/runtime`** | `ApiJsonClient`, `HitlController`, `BoundExecutor` |
| **`apps/chat-demo`** | Chat bootstrap + steady-state table/detail/charts + Data debugger + Admin approval |

### Two-phase UX (the core idea)

1. **Bootstrap** — Chat / AI or intent rules generate a simple task UI and a candidate APIJSON call. Validate and execute until `code == 200`. Emit `bindRequest` (body template + `paramMap`).
2. **Steady-state** — User changes filters, sort, paging. `BoundExecutor` merges params into the template and `POST`s to `{baseUrl}/{method}`. **No LLM.**

### Governance that matches real backends

- **Reads** auto-execute
- **Non-sensitive writes** (`post` / `put` by default) auto-execute with an `auto_approved` audit row
- **Sensitive methods** (default: `delete`, configurable) wait in an **Admin** Approve / Reject queue

That is human-in-the-loop where blast radius is high — not a modal on every harmless list refresh.

---

## Why this combination is the highlight

### 1. Agents for discovery; HTTP for operation

Use intelligence where uncertainty is high (what should we call?). Use deterministic HTTP where uncertainty should be zero (same filters → same request).

### 2. Binding is a protocol artifact, not a demo hack

`bindRequest` is a first-class envelope. Other runtimes can implement the same lifecycle without copying the chat UI.

### 3. Safer surface than NL2SQL

APIJSON requests remain structured JSON over controlled endpoints. The agent is not inventing ad-hoc SQL strings for every click.

### 4. Cost and latency collapse after the first success

Steady-state interactions are ordinary API calls. That is how you ship “AI-assisted data apps” that people will actually leave open all afternoon.

### 5. Auditability by default

You can show the exact APIJSON body (`usedLlm: false` in the demo) and keep an approval trail for sensitive and auto-approved writes.

### 6. Practical MVP, not a slide deck

Works today against [APIJSON Demo](https://github.com/APIJSON/APIJSON-Demo): list/join queries, charts, detail smart fields, Data tab debugging, Admin queue — with or without an API key (rules still cover common User / Moment / Comment intents).

---

## Side-by-side snapshot

| Dimension | Chat agents + tools | Text-to-SQL | Low-code builders | APIJSON alone | **A2API** |
|-----------|---------------------|------------|-------------------|---------------|-----------|
| NL bootstrap | Strong | Strong | Weak | Weak | **Strong** |
| Steady-state without LLM | Rare | Rare | Native | Native (manual) | **Native (bound)** |
| Avoids agent-written SQL | Depends | No | Yes | Yes | **Yes** |
| Durable request binding | Ad hoc | Weak | Strong | Manual | **Protocol-level** |
| Sensitive-write HITL | DIY | DIY | Productized | DIY | **Built in** |
| Open protocol + runtime | Partial | Partial | Closed | API only | **Yes (OSS)** |

---

## Who should care

- **Teams building agent products** that must graduate from “cool demo” to “daily tool”
- **APIJSON / internal-platform builders** who want an agent front door without giving up control
- **Security-conscious orgs** that want LLM help for reads and proposals, but approval gates for destructive writes
- **Researchers and protocol designers** exploring the gap between tool calling and durable UI–API bindings

---

## Get started

```bash
git clone <your-repo-url> a2api
cd a2api
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- Client: `http://localhost:5173`
- API: `http://localhost:3000`
- APIJSON Demo (or compatible): `http://localhost:8080`

Try a chip like **“List the latest 3 moments with authors”**, change sort or page, hit **Query / Refresh**, and watch the right panel show a steady-state call with `usedLlm: false` and the exact APIJSON body.

Optional: set your model / base URL / API key from the account menu (or `OPENAI_API_KEY`) to refine bootstrap. Without a key, built-in intent rules still work.

---

## What’s next

The MVP proves the loop. Phase 2 aims at versioned snapshots (reuse / auto-adjust / manual-adjust), local-first storage, and cross-device sync — so a bound request can become a reusable, shareable unit of work, not a one-session miracle.

---

## Bottom line

Most “AI + data” stacks keep the model in the critical path long after the hard problem is solved.
**A2API** treats the LLM as a bootstrap engine for a **working, bound, auditable APIJSON request** — then lets users and UIs operate that request at API speed.

If you are tired of paying tokens to change a sort column, or nervous about agents writing SQL, this is the open-source bet worth watching — and trying.

**A2API: propose once. Bind forever. Call without the LLM.**
