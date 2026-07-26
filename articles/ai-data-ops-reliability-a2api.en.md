# No more AI loop & token cost - A2API: AI once, API everytime !

> [中文版](./ai-data-ops-reliability-a2api.md)

> Open source. Tune the request once with AI (or rules); then filter, sort, and page over HTTP — zero tokens, no LLM in the loop.

---

## The real pain: “can query data” ≠ “can operate data reliably”

Getting an agent to list “the latest 3 moments with authors” in natural language is no longer hard. The hard part is what comes next:

- Flip the sort direction
- Add a keyword filter
- Go to page 2
- Hit refresh again

Most stacks send the whole intent back through the LLM: re-plan, re-run function calling, reassemble the request body. That produces:

| Problem | What you feel |
|---------|----------------|
| **Cost** | Every UI tweak burns tokens |
| **Latency** | Every interaction waits on a model round-trip |
| **Drift** | The same action can yield a different request body |
| **Risk** | Writes (especially deletes) are hard to approve, audit, and reproduce |

Another common path is text-to-SQL: dazzling in demos, scary in production. SQL’s blast radius is huge — one gap in sandboxing, permissions, or multi-tenancy becomes an incident.

**What’s missing is not a chattier agent, but a path that splits exploration from day-to-day operation:**

1. Use AI (or rules) to **get a working API request once**
2. **Bind** that request to a task UI
3. When users change conditions, **call HTTP directly** — no LLM

That’s what A2API is for: **reliability when AI operates data** — not another “talking query bot.”

---

## Background: three waves met — and left a gap in the middle

| Wave | What it unlocked | What it left open |
|------|------------------|-------------------|
| **LLM tool calling / agents** | Natural language → actions | Every later click still goes through the model |
| **APIJSON-style JSON ORMs / HTTP CRUD** | Structured, controlled CRUD without hand-writing every endpoint | Request bodies are still mostly authored and debugged by humans |
| **A2UI-style task UI generation** | Agents can spin up tables, forms, charts | UI without a reusable request binding stays fragile |

A2API sits at that intersection. It is not “chat bolted onto a database.” It is an **Agent-to-API protocol + runtime + MVP demo**: freeze a successful APIJSON call as `bodyTemplate` + `paramMap`, let `BoundExecutor` fire HTTP in steady state, and show `usedLlm: false` on the side panel.

In one line with the project positioning:

**AI generates the UI once; the API repeats every time — safely, quickly, and stably.**

---

## Compared with existing approaches: trade-offs first, then the value

### 1. Always-on LLM chat agents / function calling

**Pros:** Flexible for exploration; demos look great.

**Cons:** Pagination and sorting should not need another reasoning pass; results are hard to reproduce; cost scales with clicks, not with business value.

**A2API:** Bootstrap can use a model (or built-in intent rules); **steady state does not.**

---

### 2. Text-to-SQL / NL2SQL

**Pros:** Direct path to data; familiar mental model for analysts.

**Cons:** SQL has a large blast radius; dialect and schema coupling dominate failures; tenancy and permissions are easy to miss; changing conditions often means another LLM round-trip.

**A2API:** The agent proposes **APIJSON over HTTP**, not ad-hoc SQL. The project explicitly has **no SQL execution path**.

---

### 3. MCP and similar tool-discovery protocols

**Pros:** Standard way to expose tools; strong ecosystem.

**Cons:** Great at helping agents *find and call* tools; does not by itself deliver the steady-state path of **UI-bound successful requests that no longer go through the model**.

**A2API:** Fills the middle lifecycle — **propose → revise → decide → bind → re-execute** — with reusable envelope protocols.

---

### 4. Retool-class low-code / internal tools

**Pros:** Mature bindings, permissions, and ops polish.

**Cons:** Bootstrap costs engineering time, not natural language; agents are usually bolted on later; open protocols for “agent generates → approve → bind” are rare.

**A2API:** Chat (or rules) bootstraps the task UI **and** a working request; binding is first-class, not a one-off script.

---

### 5. APIJSON + APIAuto alone

**Pros:** APIJSON is powerful; APIAuto is a strong debugger.

**Cons:** No agent protocol layer; no standard propose / bind; no closed loop of “chat until it works → steady state at zero tokens.”

**A2API:** Builds on APIJSON with protocol, HITL, and bound execution. The demo can embed APIAuto so humans and agents share the same request surface.

---

## Side-by-side

| Dimension | Chat agent + tools | Text-to-SQL | Low-code | APIJSON only | **A2API** |
|-----------|--------------------|------------|----------|--------------|-----------|
| NL cold start | Strong | Strong | Weak | Weak | **Strong** |
| Steady state without LLM | Rare | Rare | Native | Native (manual) | **Native (bound)** |
| Avoids agent-written SQL | Depends | No | Yes | Yes | **Yes** |
| Reusable request binding | Ad hoc | Weak | Strong | Manual | **Protocol-level** |
| Sensitive-write HITL | DIY | DIY | Productized | DIY | **Built in** |
| Open protocol + runtime | Partial | Partial | Closed | API only | **Open source** |

---

## How A2API works: two phases, not “chat forever”

### Bootstrap (exploration)

Chat / AI or intent rules → generate a simple task UI + candidate APIJSON → validate → execute until success (`code == 200`) → emit `bindRequest` (template + `paramMap`).

### Steady-state

User changes filter / sort / page → `BoundExecutor` merges params → `POST {baseUrl}/{method}` → **no LLM, no token cost**.

### Governance (the other half of reliability)

- **Reads:** auto-execute
- **Non-sensitive writes** (default `post` / `put`): auto-execute, with an `auto_approved` audit row
- **Sensitive methods** (default `delete`, configurable): **Admin** approval queue

Block what must be blocked; keep what should stay fast — not an approve dialog on every list refresh.

---

## Why this combo is worth opening the repo

1. **Intelligence where uncertainty is high; HTTP where certainty is required** — “what should we call?” can be reasoned; “call it again with the same conditions” must be reproducible.
2. **`bindRequest` is a protocol artifact, not a demo coincidence** — other runtimes can implement the envelopes without copying the chat UI.
3. **Closer to production boundaries than NL2SQL** — structured JSON plus existing Access / Request rules, not agents inventing SQL on the fly.
4. **Cost and latency fall off a cliff after the first success** — steady state is ordinary API calls, which is what makes an all-afternoon internal tool viable.
5. **Auditable by default** — show the real APIJSON body and `usedLlm: false`; keep a trail for sensitive and auto-approved writes.
6. **A runnable MVP** — works against [APIJSON Demo](https://github.com/APIJSON/APIJSON-Demo): lists/joins, charts, detail, Data debugger, Admin queue; without an API key, built-in rules still cover common User / Moment / Comment intents.

---

## Who should care

- Product teams that need agents to graduate from “cool demo” to “used every day”
- Teams with APIJSON / internal HTTP platforms who want an agent front door without giving up control
- Security-sensitive settings where reads and proposals can accelerate, but destructive writes must be approved
- Protocol designers exploring the gap between tool calling and durable UI–API bindings

---

## Quick start

```bash
cd ~/a2api   # or clone, then enter the repo
cp .env.example .env
npm install
npm test
npm run build
npm run dev
```

- Client: http://localhost:5173
- API: http://localhost:3000
- APIJSON Demo (or compatible): http://localhost:8080

Try a chip such as **List the latest 3 moments with authors**, change sort or page, then **Query / Refresh** — the right panel should show `usedLlm: false` and the exact APIJSON body.

Optional: set AI Model / Base URL / API Key from the account menu, or `OPENAI_API_KEY` in `.env` to refine bootstrap. Without a key, built-in rules still cover common intents.

---

## In one line

Most “AI + data” stacks keep the LLM on every click long after the hard problem is solved.

**A2API treats the model as a bootstrap engine: get one bindable, auditable APIJSON request working — then hand day-to-day operation back to HTTP.**

Tired of paying tokens to change sort order, or nervous about agents writing SQL? Try it, open issues, and help harden the protocol.

**Tune once. Keep the binding. Call without the LLM.**
