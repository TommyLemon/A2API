import { describe, expect, it } from "vitest";
import { BoundExecutor } from "./bound-executor.js";
import { ApiJsonClient } from "./client.js";

describe("BoundExecutor", () => {
  it("merges data model into bodyTemplate without LLM", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new ApiJsonClient({
      baseUrl: "http://localhost:8080",
      fetchImpl: (async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        const list = body["[]"];
        const isAccess =
          list != null &&
          typeof list === "object" &&
          !Array.isArray(list) &&
          "Access" in (list as object);
        if (isAccess) {
          return new Response(
            JSON.stringify({
              code: 200,
              msg: "success",
              "[]": [
                {
                  Access: {
                    name: "Moment",
                    get: '["UNKNOWN", "LOGIN", "OWNER", "ADMIN"]',
                    head: '["UNKNOWN", "LOGIN", "OWNER", "ADMIN"]',
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
        return new Response(
          JSON.stringify({ code: 200, msg: "success", "[]": [] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    const executor = new BoundExecutor({ client });
    executor.register({
      bindingId: "moment_list",
      method: "get",
      url: "http://localhost:8080/get",
      bodyTemplate: {
        "[]": {
          count: 3,
          page: 0,
          Moment: { "@order": "date-" },
        },
      },
      paramMap: [
        { from: "/ui/page", to: "/[]/page" },
        { from: "/ui/count", to: "/[]/count" },
        { from: "/ui/order", to: "/[]/Moment/@order" },
        { from: "/ui/keyword", to: "/[]/Moment/content$" },
      ],
      triggerActions: ["search", "page_change", "sort_change"],
    });

    const { body, result } = await executor.execute("moment_list", {
      action: "page_change",
      dataModel: {
        ui: { page: 2, count: 5, order: "date+", keyword: "APIJSON" },
      },
    });

    expect(result.ok).toBe(true);
    expect(body).toEqual({
      "[]": {
        count: 5,
        page: 2,
        Moment: { "@order": "date+", content$: "APIJSON" },
      },
    });
    const momentCall = calls.find(
      (c) =>
        c.body &&
        typeof c.body === "object" &&
        (c.body as { "[]"?: { Moment?: unknown } })["[]"]?.Moment,
    );
    expect(momentCall?.url).toBe("http://localhost:8080/get");
    expect(momentCall?.body).toMatchObject({
      "[]": {
        count: 5,
        page: 2,
        Moment: { "@order": "date+", content$: "APIJSON" },
      },
      "@role": "LOGIN",
    });
  });

  it("handles trigger actions locally", () => {
    const executor = new BoundExecutor({
      client: new ApiJsonClient(),
    });
    executor.register({
      bindingId: "moment_list",
      method: "get",
      url: "http://localhost:8080/get",
      bodyTemplate: { "[]": { Moment: {} } },
      paramMap: [],
      triggerActions: ["search"],
    });
    expect(executor.handlesAction("moment_list", "search")).toBe(true);
    expect(executor.handlesAction("moment_list", "other")).toBe(false);
  });
});
