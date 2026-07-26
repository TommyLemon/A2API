/**
 * Persisted generated data-view pages and their versions (localStorage).
 * Version closed label: "v2"; open menu: "v2 2026-10-01 11:23:45".
 */

import type { FkJoinSpec } from "./fk-expand.js";
import type { JoinOp } from "./join-query.js";
import type {
  ChartDimension,
  ColumnMeta,
  DisplayKind,
} from "./result-view.js";
import type { ColumnFilter, ColumnSort } from "./table-query.js";

const STORAGE_KEY = "a2api.savedPages";
const ACTIVE_KEY = "a2api.savedPages.active";
const MAX_PAGES = 40;
const MAX_VERSIONS = 30;

export type PageFilterDef = {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
};

export type SavedPageSnapshot = {
  version: number;
  createdAt: string;
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
};

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
