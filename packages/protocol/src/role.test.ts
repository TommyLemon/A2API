import { describe, expect, it } from "vitest";
import {
  applyMethodRole,
  combineMinRoles,
  extractRequestTables,
  minRoleFromAllowed,
  parseRoleList,
  withLoginDefaults,
} from "./role.js";

describe("role helpers", () => {
  it("parses Access role lists", () => {
    expect(parseRoleList('["UNKNOWN", "LOGIN", "OWNER"]')).toEqual([
      "UNKNOWN",
      "LOGIN",
      "OWNER",
    ]);
    expect(minRoleFromAllowed(["LOGIN", "OWNER", "UNKNOWN"])).toBe("UNKNOWN");
    expect(combineMinRoles(["UNKNOWN", "LOGIN"])).toBe("LOGIN");
  });

  it("extracts tables from nested [] bodies", () => {
    expect(
      extractRequestTables({
        "[]": { Moment: {}, User: {}, count: 3 },
        tag: "Moment[]",
      }),
    ).toEqual(expect.arrayContaining(["Moment", "User"]));
  });

  it("omits @role for writes and sets min role for get", () => {
    const body = { Moment: { content: "x" }, tag: "Moment", "@role": "OWNER" };
    expect(applyMethodRole(body, "post", () => "OWNER")).toEqual({
      Moment: { content: "x" },
      tag: "Moment",
    });
    expect(
      applyMethodRole({ "[]": { Moment: {} } }, "get", () => "UNKNOWN"),
    ).toEqual({
      "[]": { Moment: {} },
      "@role": "LOGIN",
    });
  });

  it("sets login defaults to LOGIN", () => {
    expect(withLoginDefaults({ phone: "1", password: "x" })).toEqual({
      phone: "1",
      password: "x",
      defaults: { "@role": "LOGIN" },
    });
  });
});
