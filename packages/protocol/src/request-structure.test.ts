import { describe, expect, it } from "vitest";
import {
  checkVerifyConstraint,
  insertDefaultsFromStructure,
  mustFieldsFromStructure,
  pickRequestRow,
  validateRequestStructure,
} from "./request-structure.js";

describe("Request.structure", () => {
  it("picks highest version when version omitted", () => {
    const rows = [
      {
        method: "GETS",
        tag: "Privacy",
        version: 2,
        structure: { MUST: "id" },
      },
      {
        method: "GETS",
        tag: "Privacy",
        version: 4,
        structure: { MUST: "id", REFUSE: "!" },
      },
    ];
    expect(pickRequestRow(rows, "gets", "Privacy")?.version).toBe(4);
    expect(pickRequestRow(rows, "gets", "Privacy", 3)?.version).toBe(2);
  });

  it("enforces Comment POST MUST / REFUSE", () => {
    const row = {
      method: "POST",
      tag: "Comment",
      version: 1,
      structure: {
        MUST: "momentId,content",
        REFUSE: "id",
        INSERT: { "@role": "OWNER" },
      },
    };
    const bad = validateRequestStructure(
      "post",
      { Comment: { content: "hi" }, tag: "Comment" },
      row,
    );
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.path.includes("momentId"))).toBe(true);

    const withId = validateRequestStructure(
      "post",
      { Comment: { id: 1, momentId: 2, content: "hi" }, tag: "Comment" },
      row,
    );
    expect(withId.issues.some((i) => i.path.includes(".id"))).toBe(true);

    const ok = validateRequestStructure(
      "post",
      { Comment: { momentId: 2, content: "hi" }, tag: "Comment" },
      row,
    );
    expect(ok.ok).toBe(true);
  });

  it("reads INSERT defaults and MUST helpers", () => {
    const structure = {
      INSERT: { "@role": "OWNER", pictureList: [], praiseUserIdList: [] },
      REFUSE: "id",
    };
    expect(insertDefaultsFromStructure(structure, "Moment")).toEqual({
      pictureList: [],
      praiseUserIdList: [],
    });
    expect(
      mustFieldsFromStructure({ MUST: "momentId,content" }, "Comment"),
    ).toEqual(["momentId", "content"]);
  });

  it("checks VERIFY phone / length", () => {
    expect(checkVerifyConstraint("phone", "phone~", "PHONE", "13000038710")).toBe(
      null,
    );
    expect(checkVerifyConstraint("phone", "phone~", "PHONE", "123")).toMatch(
      /phone/,
    );
    expect(
      checkVerifyConstraint("pwd", "_password[{}", ">=6", "123456"),
    ).toBe(null);
    expect(
      checkVerifyConstraint("pwd", "_password[{}", ">=6", "12"),
    ).toMatch(/length/);
  });

  it("skips open GET without tag", () => {
    const r = validateRequestStructure(
      "get",
      { "[]": { Moment: {} } },
      null,
    );
    expect(r.ok).toBe(true);
  });
});
