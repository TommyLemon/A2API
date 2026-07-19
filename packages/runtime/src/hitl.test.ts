import { describe, expect, it } from "vitest";
import { MemoryApprovalLedger } from "./approval-ledger.js";
import { ApiJsonClient } from "./client.js";
import { HitlController } from "./hitl.js";

function mockClient(ok = true) {
  return new ApiJsonClient({
    baseUrl: "http://localhost:8080",
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const list = body["[]"];
      const isRequest =
        list != null &&
        typeof list === "object" &&
        !Array.isArray(list) &&
        "Request" in (list as object);
      const isAccess =
        list != null &&
        typeof list === "object" &&
        !Array.isArray(list) &&
        "Access" in (list as object);
      if (isRequest) {
        return new Response(
          JSON.stringify({
            code: 200,
            msg: "success",
            "[]": [
              {
                Request: {
                  method: "POST",
                  tag: "Moment",
                  version: 1,
                  structure: {
                    REFUSE: "id",
                    INSERT: { pictureList: [], praiseUserIdList: [] },
                  },
                },
              },
              {
                Request: {
                  method: "DELETE",
                  tag: "Comment",
                  version: 1,
                  structure: { MUST: "id" },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (isAccess) {
        return new Response(
          JSON.stringify({ code: 200, msg: "success", "[]": [] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify(
          ok
            ? { code: 200, msg: "success" }
            : { code: 400, msg: "fail" },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
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

  it("queues admin approval when no Request row (permission gate)", async () => {
    const ledger = new MemoryApprovalLedger();
    const client = mockClient();
    const hitl = new HitlController({
      client,
      policy: "auto_all",
      ledger,
    });
    hitl.propose({
      requestId: "r4",
      method: "post",
      body: {
        Comment: { content: "x", momentId: 1 },
        tag: "Comment",
      },
      risk: "write",
    });
    // Mock Request cache has Moment POST / Comment DELETE, not Comment POST
    const pending = await hitl.advance("r4");
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.permissionGate).toBe(true);
    expect(pending.issues?.some((i) => /Request row/i.test(i))).toBe(true);
    expect(ledger.list({ decision: "pending" })).toHaveLength(1);
  });

  it("admin approve reloads Request and still validates (no skip)", async () => {
    const ledger = new MemoryApprovalLedger();
    const client = mockClient();
    const hitl = new HitlController({
      client,
      policy: "auto_all",
      ledger,
    });
    hitl.propose({
      requestId: "r5",
      method: "post",
      body: {
        Comment: { content: "x", momentId: 1 },
        tag: "Comment",
      },
      risk: "write",
    });
    await hitl.advance("r5");
    // Approve without adding Comment POST Request row → stay pending (no skip)
    const decided = await hitl.decide("r5", "approve", "admin");
    expect(decided.status).toBe("awaiting_approval");
    expect(decided.issues?.some((i) => /Request row/i.test(i))).toBe(true);
    expect(ledger.list({ decision: "pending" })).toHaveLength(1);
  });

  it("admin approve succeeds after Request row appears on reload", async () => {
    let includeCommentPost = false;
    const client = new ApiJsonClient({
      baseUrl: "http://localhost:8080",
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        const list = body["[]"];
        const isRequest =
          list != null &&
          typeof list === "object" &&
          !Array.isArray(list) &&
          "Request" in (list as object);
        if (isRequest) {
          const rows: unknown[] = [
            {
              Request: {
                method: "POST",
                tag: "Moment",
                version: 1,
                structure: { REFUSE: "id" },
              },
            },
          ];
          if (includeCommentPost) {
            rows.push({
              Request: {
                method: "POST",
                tag: "Comment",
                version: 1,
                structure: { MUST: "content,momentId" },
              },
            });
          }
          return new Response(JSON.stringify({ code: 200, "[]": rows }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: 200, msg: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    const ledger = new MemoryApprovalLedger();
    const hitl = new HitlController({
      client,
      policy: "auto_all",
      ledger,
    });
    hitl.propose({
      requestId: "r6",
      method: "post",
      body: {
        Comment: { content: "x", momentId: 1 },
        tag: "Comment",
      },
      risk: "write",
    });
    await hitl.advance("r6");
    includeCommentPost = true; // admin configured Request before approve
    const decided = await hitl.decide("r6", "approve", "admin");
    expect(decided.status).toBe("done");
  });
});
