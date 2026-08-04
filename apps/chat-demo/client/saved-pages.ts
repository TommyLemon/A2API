/**
 * Persisted generated data-view pages and their versions (localStorage).
 * Version closed label: "v2"; open menu: "v2 2026-10-01 11:23:45".
 */

import type { FkJoinSpec } from "./fk-expand.js";
import type { JoinOp } from "./join-query.js";
import type { DetailTableSlot } from "./detail-crud.js";
import type {
  ChartDimension,
  ColumnMeta,
  DisplayKind,
  ViewMode,
} from "./result-view.js";
import type { ColumnFilter, ColumnSort } from "./table-query.js";

const STORAGE_KEY = "a2api.savedPages";
const ACTIVE_KEY = "a2api.savedPages.active";
const MAX_PAGES = 40;
const MAX_VERSIONS = 30;

/** List / detail / create are separate pages — never share a bare table id. */
export type PageKind = "list" | "detail" | "create";

export function pageKindFromViewMode(
  viewMode: ViewMode | undefined,
  openCreate?: boolean,
): PageKind {
  if (openCreate) return "create";
  if (viewMode === "detail") return "detail";
  return "list";
}

/** `Moment` → `moment_list` / `moment_detail` / `moment_create` */
export function surfaceIdForTable(table: string, kind: PageKind): string {
  const base = table.trim();
  if (!base) return `page_${kind}`;
  const slug =
    base.charAt(0).toLowerCase() + base.slice(1).replace(/[^A-Za-z0-9_]/g, "");
  // Strip accidental kind suffix then re-apply so Moment_list + list → moment_list
  const bare = slug.replace(/_(list|detail|create)$/i, "");
  return `${bare}_${kind}`;
}

/** Human title: always includes List / Detail / Create — never bare table name. */
export function pageTitleForTable(
  table: string,
  kind: PageKind,
  id?: string | number | null,
): string {
  const t = table.trim() || "Page";
  if (kind === "list") return `${t} List`;
  if (kind === "create") return `Create ${t}`;
  // Record id is shown in the detail header `#` control, not in the page title
  void id;
  return `${t} Detail`;
}

/**
 * Normalize plan surfaceId + title so list/detail never collapse to one table-named page.
 */
export function normalizePageIdentity(opts: {
  table: string | null | undefined;
  kind: PageKind;
  surfaceId?: string | null;
  title?: string | null;
  id?: string | number | null;
}): { surfaceId: string; title: string } {
  const table = (opts.table || "").trim();
  const kind = opts.kind;
  let surfaceId = (opts.surfaceId || "").trim();
  let title = (opts.title || "").trim();

  // Bare table / missing → kind-suffixed id
  if (
    !surfaceId ||
    (table && surfaceId.toLowerCase() === table.toLowerCase()) ||
    (!/_(list|detail|create)$/i.test(surfaceId) && table)
  ) {
    surfaceId = table
      ? surfaceIdForTable(table, kind)
      : surfaceId || `page_${kind}_${Date.now().toString(36)}`;
  } else if (
    kind === "list" &&
    /_(detail|create)$/i.test(surfaceId) &&
    table
  ) {
    surfaceId = surfaceIdForTable(table, "list");
  } else if (
    kind === "detail" &&
    /_list$/i.test(surfaceId) &&
    table
  ) {
    surfaceId = surfaceIdForTable(table, "detail");
  } else if (
    kind === "create" &&
    !/_create$/i.test(surfaceId) &&
    table
  ) {
    surfaceId = surfaceIdForTable(table, "create");
  }

  // Only auto-fill when empty / bare table — keep custom names (e.g. "register")
  const looksBareTable =
    !!table &&
    (title === table || title.toLowerCase() === table.toLowerCase());
  // Wrong-kind auto titles (e.g. "Moment List" on a detail page) → rewrite
  const autoFor = (k: PageKind) =>
    pageTitleForTable(table || "Page", k, opts.id).toLowerCase();
  const titleLc = title.toLowerCase();
  const wrongKindAuto =
    !!table &&
    !!title &&
    ((kind === "detail" &&
      (titleLc === autoFor("list") || titleLc === autoFor("create"))) ||
      (kind === "list" &&
        (titleLc === autoFor("detail") || titleLc === autoFor("create"))) ||
      (kind === "create" &&
        (titleLc === autoFor("list") || titleLc === autoFor("detail"))));
  if (!title || looksBareTable || wrongKindAuto) {
    title = pageTitleForTable(table || "Page", kind, opts.id);
  }

  return { surfaceId, title };
}

/** Slug a custom page title for optional surfaceId (register → register). */
export function slugPageTitle(title: string): string {
  const t = title.trim();
  if (!t) return "";
  return t
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_\u4e00-\u9fff-]/g, "")
    .slice(0, 48);
}

/**
 * Request.tag from page title: lowercase English, spaces → `_`, strip other chars.
 * Empty after strip → `fallback` (also normalized).
 */
export function requestTagFromPageTitle(
  title: string,
  fallback = "",
): string {
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 64);
  return normalize(title) || normalize(fallback);
}

export type PageFilterDef = {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
};

export type SavedPageSnapshot = {
  version: number;
  createdAt: string;
  /** list vs detail — detail/create pages are independent of list */
  viewMode?: ViewMode;
  /** Explicit kind when viewMode alone is ambiguous (create vs edit detail) */
  pageKind?: PageKind;
  /** Multi-table detail/create slots (op + table + relate) for pages like register */
  detailSlots?: DetailTableSlot[];
  filters: PageFilterDef[];
  bindMeta: {
    url: string;
    method: string;
    bodyTemplate: Record<string, unknown>;
  };
  columnSorts: ColumnSort[];
  columnFilters: ColumnFilter[];
  filterCombineExpr: string;
  tableJoins: Record<string, JoinOp>;
  fkExpand: Record<string, FkJoinSpec>;
  columnOrder: string[];
  columnMetas: Record<string, ColumnMeta>;
  displayKind: DisplayKind;
  chartLabelPath: string;
  chartValuePath: string;
  chartDimensions: ChartDimension[];
  chartFieldColors: Record<string, string>;
  chartFieldValues: Record<string, string>;
  combinedShowTable: boolean;
  ui: { page?: number; count?: number };
};

export type SavedPage = {
  id: string;
  title: string;
  versions: SavedPageSnapshot[];
  /** JPEG data URL of the workspace (#results) for the page picker grid. */
  thumbDataUrl?: string;
};

/** Non-empty, size-bounded data:image URL suitable for localStorage thumbs. */
export function isValidPageThumb(url: unknown): url is string {
  return (
    typeof url === "string" &&
    url.startsWith("data:image/") &&
    url.length > 64 &&
    url.length < 1_200_000
  );
}

export function getSavedPageThumb(pageId: string): string | null {
  const page = getSavedPage(pageId);
  return isValidPageThumb(page?.thumbDataUrl) ? page.thumbDataUrl : null;
}

/** Persist a workspace screenshot for the page picker. */
export function setSavedPageThumb(
  pageId: string,
  thumbDataUrl: string,
): boolean {
  if (!isValidPageThumb(thumbDataUrl)) return false;
  const pages = loadAll();
  const page = pages.find((p) => p.id === pageId);
  if (!page) return false;
  page.thumbDataUrl = thumbDataUrl;
  saveAll(pages);
  return true;
}

export type ActivePageRef = {
  pageId: string;
  version: number;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function loadAll(): SavedPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedPage =>
        isPlainObject(p) &&
        typeof p.id === "string" &&
        typeof p.title === "string" &&
        Array.isArray(p.versions),
    );
  } catch {
    return [];
  }
}

function saveAll(pages: SavedPage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pages.slice(0, MAX_PAGES)));
  } catch {
    /* quota */
  }
}

export function listSavedPages(): SavedPage[] {
  return loadAll().sort((a, b) => a.title.localeCompare(b.title));
}

export function getSavedPage(pageId: string): SavedPage | null {
  return loadAll().find((p) => p.id === pageId) ?? null;
}

export function getActivePageRef(): ActivePageRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPlainObject(parsed) ||
      typeof parsed.pageId !== "string" ||
      typeof parsed.version !== "number"
    ) {
      return null;
    }
    return { pageId: parsed.pageId, version: parsed.version };
  } catch {
    return null;
  }
}

export function setActivePageRef(ref: ActivePageRef | null) {
  try {
    if (!ref) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify(ref));
  } catch {
    /* ignore */
  }
}

/** Format for version menu: `v2 2026-10-01 11:23:45` */
export function formatVersionOption(
  version: number,
  createdAt: string,
): string {
  return `v${version} ${formatVersionTime(createdAt)}`;
}

export function formatVersionShort(version: number): string {
  return `v${version}`;
}

export function formatVersionTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function renameSavedPage(pageId: string, title: string): SavedPage | null {
  const pages = loadAll();
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;
  const next = title.trim() || page.title;
  page.title = next;
  saveAll(pages);
  return page;
}

/** Update snapshot for an existing version (no version bump). */
export function updatePageVersion(
  pageId: string,
  version: number,
  patch: Omit<SavedPageSnapshot, "version" | "createdAt">,
): SavedPageSnapshot | null {
  const pages = loadAll();
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;
  const snap = page.versions.find((v) => v.version === version);
  if (!snap) return null;
  Object.assign(snap, patch);
  saveAll(pages);
  return snap;
}

/**
 * Append a new version for a page (or create the page).
 * Returns the new snapshot and page.
 */
export function addPageVersion(
  pageId: string,
  title: string,
  snapshot: Omit<SavedPageSnapshot, "version" | "createdAt">,
): { page: SavedPage; snapshot: SavedPageSnapshot } {
  const pages = loadAll();
  let page = pages.find((p) => p.id === pageId);
  if (!page) {
    page = { id: pageId, title: title.trim() || pageId, versions: [] };
    pages.unshift(page);
  } else if (title.trim() && page.title === pageId) {
    // Only auto-fill title when still the raw id
    page.title = title.trim();
  }
  const nextVer =
    page.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const snap: SavedPageSnapshot = {
    ...snapshot,
    version: nextVer,
    createdAt: new Date().toISOString(),
  };
  page.versions.unshift(snap);
  if (page.versions.length > MAX_VERSIONS) {
    page.versions = page.versions.slice(0, MAX_VERSIONS);
  }
  // Move page to front of recents
  const rest = pages.filter((p) => p.id !== pageId);
  saveAll([page, ...rest]);
  setActivePageRef({ pageId, version: nextVer });
  return { page, snapshot: snap };
}

export function getPageVersion(
  pageId: string,
  version: number,
): SavedPageSnapshot | null {
  const page = getSavedPage(pageId);
  return page?.versions.find((v) => v.version === version) ?? null;
}

export function latestVersion(page: SavedPage): SavedPageSnapshot | null {
  if (!page.versions.length) return null;
  return page.versions.reduce((a, b) => (a.version >= b.version ? a : b));
}

/** Remove an entire page. Returns true if removed. */
export function deleteSavedPage(pageId: string): boolean {
  const pages = loadAll();
  const next = pages.filter((p) => p.id !== pageId);
  if (next.length === pages.length) return false;
  saveAll(next);
  const active = getActivePageRef();
  if (active?.pageId === pageId) setActivePageRef(null);
  return true;
}

/**
 * Remove one version. If the page has no versions left, remove the page.
 * Returns the page after deletion (or null if page was removed).
 */
export function deletePageVersion(
  pageId: string,
  version: number,
): SavedPage | null {
  const pages = loadAll();
  const page = pages.find((p) => p.id === pageId);
  if (!page) return null;
  const before = page.versions.length;
  page.versions = page.versions.filter((v) => v.version !== version);
  if (page.versions.length === before) return page;
  if (!page.versions.length) {
    saveAll(pages.filter((p) => p.id !== pageId));
    const active = getActivePageRef();
    if (active?.pageId === pageId) setActivePageRef(null);
    return null;
  }
  saveAll(pages);
  const active = getActivePageRef();
  if (active?.pageId === pageId && active.version === version) {
    const latest = latestVersion(page);
    setActivePageRef(
      latest ? { pageId, version: latest.version } : null,
    );
  }
  return page;
}
