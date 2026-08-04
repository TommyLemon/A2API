/**
 * Phone / email verification code for detail & create forms.
 * Uses APIJSON Demo `/post/verify` (send) and `/heads/verify` (check).
 */

import { withApijsonAuth } from "./aj-auth.js";
import type { SchemaComments } from "./schema-types.js";

/** APIJSON Verify.type */
export const VERIFY_TYPE = {
  login: 0,
  register: 1,
  password: 2,
  payPassword: 3,
  reload: 4,
} as const;

export type AuthVerifyKind = "phone" | "email";

export type AuthVerifyControl = {
  path: string;
  kind: AuthVerifyKind;
  getTarget: () => string;
  getCode: () => string;
  /** null = ok; string = error message */
  ensureReady: (type: number) => Promise<string | null>;
};

/** Column name / comment → phone or email (special auth fields). */
export function isAuthVerifyField(
  path: string,
  comments?: SchemaComments | null,
): AuthVerifyKind | null {
  const col = (
    path.includes(".") ? path.split(".").pop()! : path
  ).toLowerCase();
  if (
    /^(phone|mobile|cellphone|tel|telephone)$/.test(col) ||
    /(?:^|_)phone$/.test(col) ||
    /(?:^|_)mobile$/.test(col)
  ) {
    return "phone";
  }
  if (
    /^(email|mail|e_mail)$/.test(col) ||
    /(?:^|_)email$/.test(col) ||
    /(?:^|_)mail$/.test(col)
  ) {
    return "email";
  }
  const tip = String(
    comments?.columns?.[path] ??
      comments?.columns?.[col] ??
      "",
  ).toLowerCase();
  if (/(手机|电话|\bphone\b|\bmobile\b)/.test(tip)) return "phone";
  if (/(邮箱|邮件|\bemail\b|\be-mail\b)/.test(tip)) return "email";
  return null;
}

export function verifyTypeForWrite(op: "post" | "put" | "delete"): number {
  return op === "post" ? VERIFY_TYPE.register : VERIFY_TYPE.password;
}

function apijsonOk(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const code = (data as { code?: unknown }).code;
  return code === 200 || code === "200" || code == null;
}

function extractDemoCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const verifyObj = (root.Verify ?? root.verify) as
    | Record<string, unknown>
    | undefined;
  if (!verifyObj || typeof verifyObj !== "object") return null;
  // Demo format:true often puts the code under capital "Verify"
  const raw = verifyObj.verify ?? verifyObj.Verify;
  if (raw == null || typeof raw === "object") return null;
  const s = String(raw).trim();
  return s || null;
}

function errorMsg(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const msg = (data as { msg?: unknown }).msg;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  return fallback;
}

/**
 * Demo `Verify.phone` is bigint (joint PK with type). Map email → stable 11-digit
 * surrogate so `/post/verify` can insert. Do not pass `email` in the body:
 * DemoController POSTs with email=null, then getVerify filters by email and misses.
 */
function emailToVerifyPhone(email: string): string {
  let h = 2166136261;
  const s = email.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 11 digits, avoid leading zero (MySQL bigint)
  const n = (h >>> 0) % 90_000_000_000 + 10_000_000_000;
  return String(n);
}

/** Build body for DemoController post/heads verify (phone is joint PK). */
function verifyBody(
  type: number,
  kind: AuthVerifyKind,
  target: string,
  code?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type };
  body.phone = kind === "phone" ? target : emailToVerifyPhone(target);
  if (code != null) body.verify = code;
  return body;
}

export async function sendAuthVerifyCode(
  apijsonBase: string,
  opts: { type: number; kind: AuthVerifyKind; target: string },
): Promise<{ ok: boolean; msg: string; demoCode?: string }> {
  const base = apijsonBase.replace(/\/+$/, "");
  const target = opts.target.trim();
  if (!target) {
    return {
      ok: false,
      msg: opts.kind === "email" ? "Enter email first" : "Enter phone first",
    };
  }
  if (opts.kind === "phone" && !/^\d{6,15}$/.test(target)) {
    return { ok: false, msg: "Invalid phone number" };
  }
  if (opts.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    return { ok: false, msg: "Invalid email" };
  }
  try {
    const res = await fetch(
      `${base}/post/verify`,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyBody(opts.type, opts.kind, target)),
      }),
    );
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok || !apijsonOk(data)) {
      return { ok: false, msg: errorMsg(data, "Failed to send code") };
    }
    const demoCode = extractDemoCode(data) ?? undefined;
    return {
      ok: true,
      msg: demoCode ? `Code sent: ${demoCode}` : "Code sent",
      demoCode,
    };
  } catch (e) {
    return {
      ok: false,
      msg: e instanceof Error ? e.message : "Failed to send code",
    };
  }
}

export async function checkAuthVerifyCode(
  apijsonBase: string,
  opts: {
    type: number;
    kind: AuthVerifyKind;
    target: string;
    code: string;
  },
): Promise<{ ok: boolean; msg: string }> {
  const base = apijsonBase.replace(/\/+$/, "");
  const target = opts.target.trim();
  const code = opts.code.trim();
  if (!target) {
    return {
      ok: false,
      msg: opts.kind === "email" ? "Enter email first" : "Enter phone first",
    };
  }
  if (!code) {
    return { ok: false, msg: "Enter verification code" };
  }
  try {
    const res = await fetch(
      `${base}/heads/verify`,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          verifyBody(opts.type, opts.kind, target, code),
        ),
      }),
    );
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok || !apijsonOk(data)) {
      return {
        ok: false,
        msg: errorMsg(data, "Invalid verification code"),
      };
    }
    return { ok: true, msg: "ok" };
  } catch (e) {
    return {
      ok: false,
      msg: e instanceof Error ? e.message : "Verification failed",
    };
  }
}

/** Validate all non-empty phone/email targets before write. */
export async function requireAuthVerifyCodes(
  controls: AuthVerifyControl[],
  type: number,
): Promise<string | null> {
  const active = controls.filter((c) => c.getTarget());
  if (!active.length) return null;
  for (const c of active) {
    const err = await c.ensureReady(type);
    if (err) return err;
  }
  return null;
}

/** Prefer phone code when both phone and email codes are present. */
export function pickAuthVerifyCode(
  controls: AuthVerifyControl[],
): string {
  const active = controls.filter((c) => c.getTarget() && c.getCode());
  const phone = active.find((c) => c.kind === "phone");
  return (phone ?? active[0])?.getCode() ?? "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Table that owns phone/email in the write body (Privacy preferred). */
export function resolvePhoneEmailTable(
  body: Record<string, unknown>,
  preferred = "Privacy",
): string {
  const pref = body[preferred];
  if (
    isPlainObject(pref) &&
    (pref.phone != null || pref.email != null)
  ) {
    return preferred;
  }
  for (const [key, value] of Object.entries(body)) {
    if (!/^[A-Z]/.test(key) || key === "Verify") continue;
    if (
      isPlainObject(value) &&
      (value.phone != null || value.email != null)
    ) {
      return key;
    }
  }
  return preferred;
}

/** Request.structure fragment so backend fills Verify.phone/email from the form table. */
export function buildVerifyApplyStructure(
  phoneEmailTable: string,
): Record<string, unknown> {
  const t = phoneEmailTable || "Privacy";
  return {
    Verify: {
      // Consume the code row: body uses `"@delete":"Verify"`
      "@delete": "Verify",
      UPDATE: {
        "phone@": `/${t}/phone`,
        "email@": `/${t}/email`,
      },
    },
  };
}

/** CSV op-list helpers for `@post` / `@put` / `@delete`. */
function splitOpTables(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinOpTables(tables: string[]): string | undefined {
  return tables.length ? tables.join(",") : undefined;
}

/**
 * Put `"@delete":"Verify"` + `"Verify"` ahead of User / Privacy / other tables
 * (and ahead of `@post`/`@put`/tag). APIJSON walks keys in order.
 */
export function prioritizeVerifyInBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  /** 
  const del = body["@delete"];
  const verify = body.Verify;
  if (del == null && verify == null) return body;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "@delete" || k === "Verify") continue;
    rest[k] = v;
  }
  const out: Record<string, unknown> = {};
  if (del != null) out["@delete"] = del;
  if (verify != null) out.Verify = verify;
  Object.assign(out, rest);
  return out;
  */
  return body;
}

/** Same for Apply Request.structure — Verify before other table fragments. */
export function prioritizeVerifyInStructure(
  structure: Record<string, unknown>,
): Record<string, unknown> {
  /**
  if (!("Verify" in structure)) return structure;
  const verify = structure.Verify;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(structure)) {
    if (k === "Verify") continue;
    rest[k] = v;
  }
  return { Verify: verify, ...rest };
  */
  return structure;
}

/**
 * Verify is consumed via delete (not inserted/updated):
 * drop it from @post/@put and ensure body `"@delete":"Verify"`.
 * Single-table post/put → promote to crud so both ops can run.
 */
function ensureVerifyDeleteOp(
  body: Record<string, unknown>,
  method?: string,
): string | undefined {
  for (const key of ["@post", "@put"] as const) {
    const next = splitOpTables(body[key]).filter((t) => t !== "Verify");
    const joined = joinOpTables(next);
    if (joined) body[key] = joined;
    else delete body[key];
  }

  const del = splitOpTables(body["@delete"]).filter((t) => t !== "Verify");
  del.push("Verify");
  body["@delete"] = del.join(",");

  const m = (method || "").toLowerCase();
  if (m === "post" || m === "put") {
    const opKey = m === "post" ? "@post" : "@put";
    const tables = Object.keys(body).filter(
      (k) => /^[A-Z]/.test(k) && k !== "Verify",
    );
    const existing = splitOpTables(body[opKey]);
    const merged = [...new Set([...existing, ...tables])];
    const joined = joinOpTables(merged);
    if (joined) body[opKey] = joined;
    return "crud";
  }
  return method;
}

/**
 * Attach `"@delete":"Verify"` + `"Verify": { "verify": code }` at the top of
 * the write body (before User/…), and Verify structure for Apply.
 */
export function attachAuthVerifyToWritePayload(
  payload: {
    method?: string;
    body: Record<string, unknown>;
    structure?: Record<string, unknown>;
  },
  code: string,
): void {
  const c = String(code ?? "").trim();
  if (!c) return;

  payload.body.Verify = { verify: c };
  // Loose top-level verify is not used for /crud — remove if present
  delete payload.body.verify;
  const nextMethod = ensureVerifyDeleteOp(payload.body, payload.method);
  if (nextMethod) payload.method = nextMethod;
  payload.body = prioritizeVerifyInBody(payload.body);

  const phoneTable = resolvePhoneEmailTable(payload.body);
  const verifyStruct = buildVerifyApplyStructure(phoneTable);
  const prevVerify = isPlainObject(payload.structure?.Verify)
    ? (payload.structure!.Verify as Record<string, unknown>)
    : {};
  const prevUpdate = isPlainObject(prevVerify.UPDATE)
    ? (prevVerify.UPDATE as Record<string, unknown>)
    : {};
  const nextVerify = verifyStruct.Verify as Record<string, unknown>;
  const nextUpdate = isPlainObject(nextVerify.UPDATE)
    ? (nextVerify.UPDATE as Record<string, unknown>)
    : {};

  payload.structure = prioritizeVerifyInStructure({
    ...(payload.structure || {}),
    Verify: {
      ...prevVerify,
      ...nextVerify,
      UPDATE: { ...prevUpdate, ...nextUpdate },
    },
  });
}

/**
 * Append a verification-code row after a phone/email field.
 * UI copy is English (product rule).
 */
export function mountAuthVerifyField(
  parent: HTMLElement,
  opts: {
    path: string;
    kind: AuthVerifyKind;
    apijsonBase: string;
    getTarget: () => string;
    /** Default Verify.type for Send (create=register, edit/delete=password). */
    verifyType: number;
  },
): AuthVerifyControl {
  const field = document.createElement("div");
  field.className = "detail-field detail-verify-field";
  field.dataset.verifyFor = opts.path;

  const name = document.createElement("span");
  name.className = "field-name";
  name.textContent = "Verification code";
  const star = document.createElement("span");
  star.className = "field-required";
  star.textContent = " *";
  star.title = "Required for Save / Delete when phone or email is set";
  name.appendChild(star);
  field.appendChild(name);

  const row = document.createElement("div");
  row.className = "detail-verify-row";

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.className = "detail-verify-input";
  input.placeholder = "Enter code";
  input.setAttribute(
    "aria-label",
    `Verification code for ${opts.path}`,
  );

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "detail-verify-send";
  sendBtn.textContent = "Send code";

  const status = document.createElement("div");
  status.className = "muted detail-verify-status";
  status.hidden = true;

  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  const clearCooldown = () => {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    sendBtn.disabled = false;
    sendBtn.textContent = "Send code";
  };

  const startCooldown = (sec: number) => {
    clearCooldown();
    let left = sec;
    sendBtn.disabled = true;
    sendBtn.textContent = `Resend ${left}s`;
    cooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearCooldown();
        return;
      }
      sendBtn.textContent = `Resend ${left}s`;
    }, 1000);
  };

  sendBtn.onclick = () => {
    void (async () => {
      status.hidden = false;
      status.textContent = "Sending…";
      sendBtn.disabled = true;
      const result = await sendAuthVerifyCode(opts.apijsonBase, {
        type: opts.verifyType,
        kind: opts.kind,
        target: opts.getTarget(),
      });
      status.textContent = result.msg;
      if (result.ok) startCooldown(60);
      else {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send code";
      }
    })();
  };

  row.append(input, sendBtn);
  field.append(row, status);
  parent.appendChild(field);

  return {
    path: opts.path,
    kind: opts.kind,
    getTarget: opts.getTarget,
    getCode: () => input.value.trim(),
    ensureReady: async (type) => {
      const target = opts.getTarget();
      if (!target) return null;
      const code = input.value.trim();
      if (!code) {
        return `Enter verification code for ${opts.path}`;
      }
      const check = await checkAuthVerifyCode(opts.apijsonBase, {
        type,
        kind: opts.kind,
        target,
        code,
      });
      return check.ok ? null : check.msg;
    },
  };
}
