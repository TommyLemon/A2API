import { describe, expect, it } from "vitest";
import { MemoryApprovalLedger } from "./approval-ledger.js";
import { ApiJsonClient } from "./client.js";
import { HitlController } from "./hitl.js";

function mockClient(ok = true) {
  return new ApiJsonClient({
    baseUrl: "http://localhost:8080",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify(
          ok
            ? { code: 200, msg: "success" }
            : { code: 400, msg: "fail" },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch,
  });
}

describe("HitlController auto_nonsensitive", () => {
  it("auto-executes post and stores auto_approved ledger row", async () => {
    const ledger = new MemoryApprovalLedger();
    const hitl = new HitlController({
      client: mockClient(),
      policy: "auto_nonsensitive",
      ledger,
      sensitiveMethods: new Set(["delete"]),
    });
    hitl.propose({
      requestId: "r1",
      method: "post",
      body: { Moment: { content: "hi" }, tag: "Moment" },
      risk: "write",
    });
    const pending = await hitl.advance("r1");
    expect(pending.status).toBe("done");
    expect(pending.sensitive).toBe(false);
    const rows = ledger.list({ decision: "auto_approved" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.method).toBe("post");
    expect(rows[0]?.decidedBy).toBe("system");
  });

  it("queues delete for admin approval then approves", async () => {
    const ledger = new MemoryApprovalLedger();
    const hitl = new HitlController({
      client: mockClient(),
      policy: "auto_nonsensitive",
      ledger,
    });
    hitl.propose({
      requestId: "r2",
      method: "delete",
      body: { Comment: { id: 22 }, tag: "Comment" },
      risk: "write",
    });
    const pending = await hitl.advance("r2");
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.sensitive).toBe(true);
    expect(ledger.list({ decision: "pending" })).toHaveLength(1);
    const decided = await hitl.decide("r2", "approve", "admin@test");
    expect(decided.status).toBe("done");
    expect(ledger.list({ decision: "approved" })).toHaveLength(1);
    expect(ledger.list({ decision: "pending" })).toHaveLength(0);
  });

  it("rejects sensitive delete without success result", async () => {
    const ledger = new MemoryApprovalLedger();
    const hitl = new HitlController({
      client: mockClient(),
      policy: "auto_nonsensitive",
      ledger,
    });
    hitl.propose({
      requestId: "r3",
      method: "delete",
      body: { Comment: { id: 1 }, tag: "Comment" },
      risk: "write",
    });
    await hitl.advance("r3");
    const decided = await hitl.decide("r3", "reject", "admin");
    expect(decided.status).toBe("rejected");
    expect(ledger.list({ decision: "rejected" })[0]?.decidedBy).toBe("admin");
  });
});
