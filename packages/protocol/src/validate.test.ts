import { describe, expect, it } from "vitest";
import {
  validateApiJsonBody,
  validateBindRequest,
  validateProposeRequest,
  parseEnvelope,
} from "./validate.js";
import { getByPointer, setByPointer } from "./pointer.js";
import { A2API_VERSION } from "./types.js";

describe("validateApiJsonBody CRUD samples", () => {
  it("accepts GET user", () => {
    const r = validateApiJsonBody("get", { User: {} });
    expect(r.ok).toBe(true);
  });

  it("accepts GET array with columns", () => {
    const r = validateApiJsonBody("get", {
      "[]": {
        count: 3,
        User: { "@column": "id,name" },
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts POST Moment with tag", () => {
    const r = validateApiJsonBody("post", {
      Moment: {
        userId: 38710,
        content: "APIJSON is the real-time coding-free ORM",
      },
      tag: "Moment",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects POST without tag", () => {
    const r = validateApiJsonBody("post", {
      Moment: { userId: 38710, content: "x" },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "body.tag")).toBe(true);
  });

  it("accepts PUT with id and tag", () => {
    const r = validateApiJsonBody("put", {
      Moment: { id: 235, content: "updated" },
      tag: "Moment",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects PUT without id", () => {
    const r = validateApiJsonBody("put", {
      Moment: { content: "updated" },
      tag: "Moment",
    });
    expect(r.ok).toBe(false);
  });

  it("accepts DELETE with id{}", () => {
    const r = validateApiJsonBody("delete", {
      Comment: { "id{}": [100, 110, 120] },
      tag: "Comment[]",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects DELETE without id", () => {
    const r = validateApiJsonBody("delete", {
      Comment: {},
      tag: "Comment",
    });
    expect(r.ok).toBe(false);
  });
});

describe("propose and bind", () => {
  it("validates proposeRequest", () => {
    const r = validateProposeRequest({
      requestId: "r1",
      method: "get",
      body: { User: { id: 38710 } },
      risk: "read",
    });
    expect(r.ok).toBe(true);
  });

  it("validates bindRequest from plan sample", () => {
    const r = validateBindRequest({
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
      resultPath: "/rows",
      triggerActions: ["search", "page_change", "sort_change"],
    });
    expect(r.ok).toBe(true);
  });

  it("parses envelope", () => {
    const { envelope, issues } = parseEnvelope({
      version: A2API_VERSION,
      proposeRequest: {
        requestId: "x",
        method: "get",
        body: { User: {} },
      },
    });
    expect(issues).toEqual([]);
    expect(envelope && "proposeRequest" in envelope).toBe(true);
  });
});

describe("pointer merge", () => {
  it("sets nested APIJSON paths", () => {
    const body = {
      "[]": {
        count: 3,
        page: 0,
        Moment: { "@order": "date-" },
      },
    };
    const next = setByPointer(body, "/[]/page", 2) as typeof body;
    expect(getByPointer(next, "/[]/page")).toBe(2);
    expect(getByPointer(next, "/[]/Moment/@order")).toBe("date-");
  });
});
