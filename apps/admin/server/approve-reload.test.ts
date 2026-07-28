/**
 * Unit: approve → /post/verify (TYPE_RELOAD) → /reload.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiJsonClient } from "@a2api/runtime";
import { reloadApijsonConfig, VERIFY_TYPE_RELOAD } from "./approve-writer.js";

describe("reloadApijsonConfig", () => {
  it("posts verify then reload with extracted code", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: href, body });
      if (href.endsWith("/post/verify")) {
        return new Response(
          JSON.stringify({
            code: 200,
            Verify: { type: VERIFY_TYPE_RELOAD, phone: 13000082001, verify: 4321 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (href.endsWith("/reload")) {
        return new Response(
          JSON.stringify({ code: 200, msg: "success", Access: {}, Request: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    });

    const client = new ApiJsonClient({
      baseUrl: "http://apijson.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await reloadApijsonConfig(client, {
      phone: "13000082001",
      type: "ALL",
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("http://apijson.test/post/verify");
    expect(calls[0]!.body).toEqual({
      type: VERIFY_TYPE_RELOAD,
      phone: "13000082001",
    });
    expect(calls[1]!.url).toBe("http://apijson.test/reload");
    expect(calls[1]!.body).toEqual({
      type: "ALL",
      phone: "13000082001",
      verify: "4321",
    });
  });

  it("fails when verify code is missing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 200, Verify: { type: 4 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new ApiJsonClient({
      baseUrl: "http://apijson.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await reloadApijsonConfig(client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Verify code missing/i);
  });
});
