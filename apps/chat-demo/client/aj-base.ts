/**
 * Browser calls APIJSON only via same-origin `/apijson` → Node BFF.
 * Node holds JSESSIONID; browser holds `a2api_aj` sid (+ optional auth headers).
 *
 * Named aj-base (not apijson-*) so Vite's /apijson proxy never steals this module URL.
 */

export const APIJSON_BROWSER_BASE = "/apijson";

/** Default upstream for external tools (APIAuto) that cannot use the proxy. */
export const APIJSON_UPSTREAM_DEFAULT = "http://localhost:8080";

export function normalizeApijsonBase(base: string): string {
  return (base || APIJSON_BROWSER_BASE).replace(/\/+$/, "");
}

/**
 * Rewrite any APIJSON method URL to the browser BFF base.
 * e.g. http://localhost:8080/get → /apijson/get
 * Bound templates from the server still carry the absolute upstream URL.
 */
export function toBrowserApijsonUrl(
  url: string,
  browserBase: string = APIJSON_BROWSER_BASE,
): string {
  const base = normalizeApijsonBase(browserBase);
  const u = (url || "").trim();
  if (!u) return `${base}/get`;
  if (u.startsWith("/") && !u.startsWith("//")) {
    const path = u.split("?")[0].replace(/\/+$/, "");
    if (path === base || path.startsWith(`${base}/`)) return path;
    const method = path.split("/").filter(Boolean).pop() || "get";
    return `${base}/${method}`;
  }
  try {
    const parsed = new URL(u);
    const method =
      parsed.pathname.split("/").filter(Boolean).pop() || "get";
    return `${base}/${method}`;
  } catch {
    const method = u.split("/").filter(Boolean).pop() || "get";
    return `${base}/${method}`;
  }
}

/** Extract APIJSON base from a method URL (/apijson/get or http://host:8080/get). */
export function apijsonBaseFromUrl(url: string): string {
  const u = (url || "").trim();
  if (!u) return APIJSON_BROWSER_BASE;
  if (u.startsWith("/") && !u.startsWith("//")) {
    const path = u.split("?")[0].replace(/\/+$/, "");
    const segs = path.split("/").filter(Boolean);
    if (segs[0] === "apijson") return APIJSON_BROWSER_BASE;
    return segs[0] ? `/${segs[0]}` : APIJSON_BROWSER_BASE;
  }
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return APIJSON_BROWSER_BASE;
  }
}

/** Expand proxy-relative URL for APIAuto / direct upstream links. */
export function apijsonUpstreamUrl(
  url: string,
  upstream: string = APIJSON_UPSTREAM_DEFAULT,
): string {
  const u = url.trim();
  const up = upstream.replace(/\/+$/, "");
  if (u.startsWith("/apijson")) {
    const rest = u.slice("/apijson".length);
    if (!rest) return up;
    return `${up}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  if (u.startsWith("/") && !u.startsWith("//")) {
    return `${up}${u}`;
  }
  return u;
}

/** Prior direct-host defaults that should migrate to the same-origin proxy. */
export function isLegacyDirectApijsonBase(base: string): boolean {
  const b = base.replace(/\/+$/, "");
  return (
    !b ||
    b === "http://localhost:8080" ||
    b === "http://127.0.0.1:8080"
  );
}
