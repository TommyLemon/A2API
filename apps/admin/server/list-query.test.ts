import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileApplicationStore } from "./application-store.js";
import {
  clampPageSize,
  normalizeOrder,
  paginateInMemory,
} from "./list-query.js";

describe("list-query helpers", () => {
  it("clamps page size to 1–100", () => {
    expect(clampPageSize(0)).toBe(20);
    expect(clampPageSize(5)).toBe(5);
    expect(clampPageSize(999)).toBe(100);
  });

  it("normalizes order against whitelist", () => {
    expect(normalizeOrder("date+", ["date", "id"], "id-")).toBe("date+");
    expect(normalizeOrder("hack-", ["date", "id"], "id-")).toBe("id-");
    expect(normalizeOrder("id", ["id"], "date-")).toBe("id-");
  });

  it("paginates in memory", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(paginateInMemory(rows, 1, 2)).toEqual({
      items: [3, 4],
      total: 5,
      page: 1,
      pageSize: 2,
    });
  });
});

describe("FileApplicationStore list page/filter/sort", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("filters by status, sorts, and pages", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a2-list-"));
    dirs.push(dir);
    const store = new FileApplicationStore(path.join(dir, "a.jsonl"));
    await store.submit({
      table: "User",
      operation: "get",
      method: "POST",
      url: "http://localhost/get",
      json: {},
    });
    await store.submit({
      table: "Moment",
      operation: "post",
      method: "POST",
      url: "http://localhost/post",
      json: {},
    });
    const second = await store.submit({
      table: "Comment",
      operation: "put",
      method: "POST",
      url: "http://localhost/put",
      json: {},
    });
    await store.update(second.id, { status: "approved" });

    const pending = await store.list({
      status: ["pending"],
      page: 0,
      pageSize: 10,
      order: "bizTable+",
    });
    expect(pending.total).toBe(2);
    expect(pending.items.map((r) => r.table)).toEqual(["Moment", "User"]);

    const page0 = await store.list({
      status: ["pending"],
      page: 0,
      pageSize: 1,
      order: "bizTable+",
    });
    expect(page0.items).toHaveLength(1);
    expect(page0.items[0]!.table).toBe("Moment");
    expect(page0.total).toBe(2);

    const q = await store.list({ q: "user", page: 0, pageSize: 10 });
    expect(q.total).toBe(1);
    expect(q.items[0]!.table).toBe("User");
  });
});
