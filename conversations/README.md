# Conversations (git-managed)

Curated bootstrap chat examples and session transcripts for the A2API demo.
Commit new flows here so the team can replay and review them without relying on local-only chat history.

## Files

| File | Purpose |
|------|---------|
| `bootstrap-examples.json` | Quick-chip prompts + expected intent targets |
| `sample-session-moments.json` | Example multi-turn session (moments list → filter → analyze) |

## Exporting a live session

In the browser console after chatting:

```js
// Copy messages from the UI panel, or extend a2apiAgent later.
JSON.stringify({ exportedAt: new Date().toISOString(), notes: "…" }, null, 2)
```

Save under `conversations/` and commit.
