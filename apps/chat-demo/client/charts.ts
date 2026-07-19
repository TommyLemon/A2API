/** Lightweight SVG charts for list data (no external chart lib). */

export type ChartPoint = { label: string; value: number };

export type ChartKind = "bar" | "line" | "pie" | "doughnut" | "area";

/** Default palette — each field / series gets a distinct color. */
export const CHART_PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#6366f1",
] as const;

/** @deprecated use CHART_PALETTE */
const PIE_COLORS = CHART_PALETTE;

export type ChartDimension = {
  id: string;
  /** Editable display name shown on the chart title bar. */
  name?: string;
  /**
   * X-axis / category grouping field (defaulted + user-selectable).
   * Series `fields` are aggregated within each groupBy value.
   */
  groupBy?: string;
  /** Series fields (multi-select): each gets color + Count/aggregate. */
  fields: string[];
  /** Chart form for Charts mode (ignored when a single chart tab is active). */
  chartKind?: ChartKind;
  /** Charts: whether to show this dimension; default true */
  enabled?: boolean;
  /** Optional field picker expanded; default true (expanded) */
  fieldsOpen?: boolean;
};

export function defaultDimensionName(index: number): string {
  return `Dimension ${index + 1}`;
}

export type ChartRenderOptions = {
  /** Primary series color (bar/line/area). Pie still uses palette per slice. */
  color?: string;
  /** Optional per-slice / per-bar colors (pie & bar categories). */
  categoryColors?: string[];
};

export function defaultChartColor(index: number): string {
  const n = CHART_PALETTE.length;
  return CHART_PALETTE[((index % n) + n) % n]!;
}

/** Stable default color for a field path among known choices. */
export function colorForField(
  path: string,
  fieldColors: Record<string, string>,
  fieldOrder: string[],
): string {
  if (fieldColors[path]) return fieldColors[path]!;
  const idx = fieldOrder.indexOf(path);
  return defaultChartColor(idx >= 0 ? idx : hashStr(path));
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Fill missing field colors from palette (unique when possible). */
export function ensureFieldColors(
  fields: string[],
  existing: Record<string, string> = {},
): Record<string, string> {
  const out = { ...existing };
  const used = new Set(Object.values(out).map((c) => c.toLowerCase()));
  let cursor = 0;
  for (const f of fields) {
    if (out[f]) continue;
    let color = defaultChartColor(cursor);
    let guard = 0;
    while (used.has(color.toLowerCase()) && guard < CHART_PALETTE.length) {
      cursor++;
      color = defaultChartColor(cursor);
      guard++;
    }
    out[f] = color;
    used.add(color.toLowerCase());
    cursor++;
  }
  return out;
}

/** Normalize to #rrggbb for `<input type="color">` and SVG. */
export function toCssColor(c: string | undefined | null, fallback = "#3b82f6"): string {
  if (!c) return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1]!,
      g = s[2]!,
      b = s[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

/**
 * Series color for a chart: always from the first selected field's color.
 * Dimensions do not own colors — only fields do.
 */
export function dimensionSeriesColor(
  dim: ChartDimension,
  fieldColors: Record<string, string>,
  fieldOrder: string[],
  dimIndex: number,
): string {
  const first = dim.fields[0];
  if (!first) return defaultChartColor(dimIndex);
  return toCssColor(
    colorForField(first, fieldColors, fieldOrder),
    defaultChartColor(dimIndex),
  );
}

export const CHART_KIND_OPTIONS: Array<{ kind: ChartKind; label: string }> = [
  { kind: "bar", label: "Bar" },
  { kind: "line", label: "Line" },
  { kind: "area", label: "Area" },
  { kind: "pie", label: "Pie" },
  { kind: "doughnut", label: "Doughnut" },
];

export function chartKindLabel(kind: ChartKind): string {
  return CHART_KIND_OPTIONS.find((o) => o.kind === kind)?.label ?? kind;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v);
  }
  return null;
}

/** id / *Id / *_id — not chart metrics (e.g. toId, userId). */
export function isIdLikeColumn(path: string): boolean {
  const name = path.includes(".") ? path.split(".").pop()! : path;
  if (name === "id") return true;
  if (/Id$/i.test(name)) return true;
  if (/_id$/i.test(name)) return true;
  return false;
}

/** Numeric columns suitable as chart values (excludes FK/id). */
export function listNumericColumns(
  columns: string[],
  rows: Array<{ cells: Record<string, unknown> }>,
): string[] {
  return columns.filter(
    (c) =>
      !isIdLikeColumn(c) && rows.some((r) => toNumber(r.cells[c]) != null),
  );
}

/** Aggregation for chart values. */
export type ChartAggOp =
  | "count"
  | "data"
  | "sum"
  | "avg"
  | "max"
  | "min"
  | "custom";

export type ChartMeasureKind = "number" | "arrayLen";

export type ChartMeasure = {
  path: string;
  kind: ChartMeasureKind;
  /** Short UI label */
  label: string;
};

export type ChartValueSpec = {
  /** __count__ or field path */
  path: string;
  agg: ChartAggOp;
  measureKind?: ChartMeasureKind;
  /** When agg=custom: APIJSON/SQL expression, e.g. count(distinct userId) */
  customExpr?: string;
};

/** Enum / flag ints that look numeric but are category dimensions, not measures. */
const NON_MEASURE_NUMBER_COLS = new Set([
  "sex",
  "status",
  "type",
  "state",
  "flag",
  "deleted",
  "toId",
  "userId",
  "momentId",
]);

/** Demo-schema metrics usable even when not in current @column (server can still agg). */
const KNOWN_NUMBER_METRICS: Record<string, string[]> = {
  Moment: ["commentCount"],
  User: [],
  Comment: [],
};

const KNOWN_ARRAY_METRICS: Record<string, string[]> = {
  Moment: ["praiseUserIdList", "pictureList"],
  User: ["contactIdList", "pictureList"],
  Comment: [],
};

export const CHART_AGG_OPTIONS: Array<{ op: ChartAggOp; label: string }> = [
  { op: "count", label: "Count" },
  { op: "data", label: "Data" },
  { op: "sum", label: "Sum" },
  { op: "avg", label: "Average" },
  { op: "max", label: "Max" },
  { op: "min", label: "Min" },
  { op: "custom", label: "Custom" },
];

/** Allow safe APIJSON aggregate / SQL function text for custom metrics. */
export function sanitizeCustomAggExpr(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return "";
  // Letters, digits, _ . ( ) , + - * / % spaces — no quotes/semicolons
  if (!/^[a-zA-Z_][a-zA-Z0-9_.,()+\-*/%\s]*$/.test(t)) return "";
  if (t.length > 120) return "";
  return t;
}

function isArrayValue(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function measureValue(
  cells: Record<string, unknown>,
  path: string,
  kind: ChartMeasureKind,
): number | null {
  const v = cells[path];
  if (kind === "arrayLen") {
    if (isArrayValue(v)) return v.length;
    if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (Array.isArray(parsed)) return parsed.length;
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  return toNumber(v);
}

function arrayLenHint(name: string): string {
  if (/praise/i.test(name)) return "Likes";
  if (/picture|photo/i.test(name)) return "Images";
  if (/contact/i.test(name)) return "Contacts";
  return "";
}

function isPlausibleMeasureCol(name: string): boolean {
  if (NON_MEASURE_NUMBER_COLS.has(name)) return false;
  if (/Id$/i.test(name) && name !== "commentCount") return false;
  if (/^(name|content|title|tag|head|date|time)$/i.test(name)) return false;
  return true;
}

/**
 * Discover chart Y-axis measures:
 * - numeric / array columns on the page
 * - columnMetas typed as number
 * - known demo metrics for active tables (even if missing from @column)
 */
export function listChartMeasures(
  columns: string[],
  rows: Array<{ cells: Record<string, unknown> }>,
  shortLabelFn?: (path: string) => string,
  opts?: {
    activeTables?: string[];
    numberPathsFromMeta?: string[];
    /** When true, allow known metrics not present in `columns`. */
    includeKnown?: boolean;
  },
): ChartMeasure[] {
  const labelOf = shortLabelFn ?? ((p: string) => p.split(".").pop() || p);
  const seen = new Set<string>();
  const out: ChartMeasure[] = [];
  const colSet = new Set(columns);
  const tables = opts?.activeTables?.length
    ? new Set(opts.activeTables)
    : null;
  const includeKnown = opts?.includeKnown !== false;

  const add = (
    path: string,
    kind: ChartMeasureKind,
    labelExtra?: string,
    requireInColumns = true,
  ) => {
    if (requireInColumns && !colSet.has(path)) return;
    const table = path.includes(".") ? path.split(".")[0]! : "";
    if (tables && table && !tables.has(table)) return;
    if (seen.has(`${kind}:${path}`)) return;
    seen.add(`${kind}:${path}`);
    const base = labelOf(path);
    out.push({
      path,
      kind,
      label:
        kind === "arrayLen"
          ? `${base} (length${labelExtra ? `·${labelExtra}` : ""})`
          : base,
    });
  };

  for (const c of columns) {
    if (isIdLikeColumn(c)) continue;
    const name = c.split(".").pop() || c;
    if (!isPlausibleMeasureCol(name)) continue;

    if (rows.some((r) => toNumber(r.cells[c]) != null)) {
      add(c, "number");
    } else if (
      rows.some(
        (r) =>
          isArrayValue(r.cells[c]) ||
          (typeof r.cells[c] === "string" && /^\s*\[/.test(String(r.cells[c]))),
      )
    ) {
      add(c, "arrayLen", arrayLenHint(name));
    } else if (/List$|Count$/i.test(name)) {
      // Column present but empty / unparsed on this page — still offer as measure
      add(c, /List$/i.test(name) ? "arrayLen" : "number", arrayLenHint(name));
    }
  }

  for (const path of opts?.numberPathsFromMeta ?? []) {
    if (isIdLikeColumn(path)) continue;
    const name = path.split(".").pop() || path;
    if (!isPlausibleMeasureCol(name)) continue;
    add(path, "number", undefined, true);
  }

  if (includeKnown) {
    for (const [table, cols] of Object.entries(KNOWN_NUMBER_METRICS)) {
      for (const col of cols) {
        if (!col) continue;
        add(`${table}.${col}`, "number", undefined, false);
      }
    }
    for (const [table, cols] of Object.entries(KNOWN_ARRAY_METRICS)) {
      for (const col of cols) {
        add(`${table}.${col}`, "arrayLen", arrayLenHint(col), false);
      }
    }
  }

  return out;
}

/**
 * Per category-field Y options: Count / Data / Sum / Avg / Max / Min / Custom
 * (aggregates this field itself — Custom allows a typed expression).
 */
export function listFieldValueOptions(
  fieldPath: string,
  measureKind: ChartMeasureKind | null | undefined,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [
    { value: "__count__", label: "Count" },
  ];
  const kind = measureKind ?? "number";
  for (const agg of ["data", "sum", "avg", "max", "min"] as ChartAggOp[]) {
    const aggLabel =
      CHART_AGG_OPTIONS.find((o) => o.op === agg)?.label ?? agg;
    out.push({
      value: serializeChartValue({
        path: fieldPath,
        agg,
        measureKind: kind,
      }),
      label: aggLabel,
    });
  }
  out.push({
    value: serializeChartValue({
      path: fieldPath,
      agg: "custom",
      measureKind: kind,
      customExpr: "",
    }),
    label: "Custom",
  });
  return out;
}

export function defaultAggForMeasure(kind: ChartMeasureKind): ChartAggOp {
  return kind === "arrayLen" ? "sum" : "sum";
}

export function aggsForMeasure(kind: ChartMeasureKind | "count"): ChartAggOp[] {
  if (kind === "count") return ["count"];
  return ["data", "sum", "avg", "max", "min", "count", "custom"];
}

export function serializeChartValue(spec: ChartValueSpec): string {
  if (spec.path === "__count__" || (spec.agg === "count" && spec.path === "__count__")) {
    return "__count__";
  }
  const kind = spec.measureKind === "arrayLen" ? "len" : "num";
  if (spec.agg === "custom") {
    const expr = spec.customExpr ?? "";
    return `custom:${kind}:${spec.path}::${expr}`;
  }
  return `${spec.agg}:${kind}:${spec.path}`;
}

export function parseChartValue(raw: string | undefined | null): ChartValueSpec {
  if (!raw || raw === "__count__") {
    return { path: "__count__", agg: "count" };
  }
  const custom = raw.match(/^custom:(num|len):(.+?)::(.*)$/);
  if (custom) {
    return {
      agg: "custom",
      measureKind: custom[1] === "len" ? "arrayLen" : "number",
      path: custom[2]!,
      customExpr: custom[3] ?? "",
    };
  }
  const m = raw.match(/^(sum|avg|max|min|count|data):(num|len):(.+)$/);
  if (m) {
    return {
      agg: m[1] as ChartAggOp,
      measureKind: m[2] === "len" ? "arrayLen" : "number",
      path: m[3]!,
    };
  }
  // Legacy: bare path → sum
  if (!raw.includes(":")) {
    return { path: raw, agg: "sum", measureKind: "number" };
  }
  return { path: "__count__", agg: "count" };
}

export function listLabelColumns(
  columns: string[],
  numeric: string[],
): string[] {
  const labels = columns.filter(
    (c) =>
      !isIdLikeColumn(c) &&
      (!numeric.includes(c) || /name|content|title|tag|date/i.test(c)),
  );
  return labels.length ? labels : columns.filter((c) => !isIdLikeColumn(c));
}

/** Pick a categorical label column and a numeric value column. */
export function pickChartFields(
  columns: string[],
  rows: Array<{ cells: Record<string, unknown>; key: string }>,
  preferredValue?: string,
  preferredLabel?: string,
): { labelPath: string; valuePath: string } | null {
  if (!columns.length || !rows.length) return null;

  const numeric = listNumericColumns(columns, rows);
  const labels = listLabelColumns(columns, numeric);

  const preferredOk =
    preferredValue &&
    preferredValue !== "__count__" &&
    columns.includes(preferredValue) &&
    !isIdLikeColumn(preferredValue)
      ? preferredValue
      : "";
  const valuePath =
    preferredOk ||
    numeric[0] ||
    // count mode: any column can be value via aggregation
    preferredValue ||
    "";
  const labelPath =
    (preferredLabel && columns.includes(preferredLabel) && preferredLabel) ||
    labels.find((c) => /name|content|title/i.test(c)) ||
    labels[0] ||
    columns.find((c) => !isIdLikeColumn(c)) ||
    columns[0];

  if (!labelPath) return null;
  return { labelPath, valuePath: valuePath || labelPath };
}

function cellLabel(v: unknown, fallback = "—"): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

/**
 * Build points from rows using a value spec (count / sum / avg / max / min,
 * including array-length measures).
 */
export function buildPoints(
  rows: Array<{ cells: Record<string, unknown>; key: string }>,
  labelPaths: string | string[],
  value: string | ChartValueSpec,
): ChartPoint[] {
  const paths = (
    Array.isArray(labelPaths) ? labelPaths : [labelPaths]
  ).filter(Boolean);
  if (!paths.length) return [];

  const spec = typeof value === "string" ? parseChartValue(value) : value;
  const kind: ChartMeasureKind = spec.measureKind ?? "number";

  type Bucket = {
    sum: number;
    count: number;
    max: number;
    min: number;
    last: number | null;
  };
  const acc = new Map<string, Bucket>();

  // Custom SQL aggs need the server; local preview stays empty
  if (spec.agg === "custom") return [];

  for (const r of rows) {
    const raw = paths.map((p) => cellLabel(r.cells[p])).join(" / ");
    const label = raw.length > 28 ? raw.slice(0, 27) + "…" : raw;
    let bucket = acc.get(label);
    if (!bucket) {
      bucket = {
        sum: 0,
        count: 0,
        max: Number.NEGATIVE_INFINITY,
        min: Number.POSITIVE_INFINITY,
        last: null,
      };
      acc.set(label, bucket);
    }

    if (
      spec.path === "__count__" ||
      (spec.agg === "count" && spec.path === "__count__")
    ) {
      bucket.count += 1;
      bucket.sum += 1;
      continue;
    }

    if (spec.agg === "count" && spec.path !== "__count__") {
      const n = measureValue(r.cells, spec.path, kind);
      if (n != null) bucket.count += 1;
      continue;
    }

    const n = measureValue(r.cells, spec.path, kind);
    if (n == null) continue;
    bucket.sum += n;
    bucket.count += 1;
    bucket.last = n;
    if (n > bucket.max) bucket.max = n;
    if (n < bucket.min) bucket.min = n;
  }

  return [...acc.entries()].map(([label, b]) => {
    let value = 0;
    if (spec.path === "__count__") value = b.count;
    else if (spec.agg === "count") value = b.count;
    else if (spec.agg === "data") value = b.last ?? 0;
    else if (spec.agg === "sum") value = b.sum;
    else if (spec.agg === "avg") value = b.count ? b.sum / b.count : 0;
    else if (spec.agg === "max") value = b.count ? b.max : 0;
    else if (spec.agg === "min") value = b.count ? b.min : 0;
    // Round avg for display stability
    if (spec.agg === "avg") value = Math.round(value * 100) / 100;
    return { label, value };
  });
}

export function chartValueTitle(
  spec: ChartValueSpec,
  shortLabelFn: (path: string) => string,
): string {
  if (spec.path === "__count__") return "Count";
  if (spec.agg === "custom") {
    const expr = (spec.customExpr || "").trim();
    return expr ? `Custom · ${expr}` : "Custom";
  }
  const name = shortLabelFn(spec.path);
  const aggLabel =
    CHART_AGG_OPTIONS.find((o) => o.op === spec.agg)?.label ?? spec.agg;
  const kindHint = spec.measureKind === "arrayLen" ? " length" : "";
  return kindHint ? `${name}${kindHint}·${aggLabel}` : `${name}·${aggLabel}`;
}

export function newChartDimensionId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function seriesColor(opts?: ChartRenderOptions, fallbackIndex = 0): string {
  return opts?.color || defaultChartColor(fallbackIndex);
}

function pointColor(i: number, opts?: ChartRenderOptions): string {
  if (opts?.categoryColors?.[i]) {
    return toCssColor(opts.categoryColors[i]);
  }
  // Pie slices: rotate palette starting from the field's series color
  let start = 0;
  if (opts?.color) {
    const hex = toCssColor(opts.color);
    const idx = (CHART_PALETTE as readonly string[]).indexOf(hex);
    start = idx >= 0 ? idx : hashStr(hex) % CHART_PALETTE.length;
  }
  return defaultChartColor(start + i);
}

export function renderBarChart(
  host: HTMLElement,
  points: ChartPoint[],
  title: string,
  opts?: ChartRenderOptions,
): void {
  host.innerHTML = "";
  if (!points.length) {
    host.innerHTML = `<div class="result-empty">No chartable data</div>`;
    return;
  }
  const w = Math.max(480, host.clientWidth || 560);
  const h = 280;
  const pad = { t: 28, r: 16, b: 56, l: 48 };
  const max = Math.max(...points.map((p) => p.value), 1);
  const bw = (w - pad.l - pad.r) / points.length;
  const barW = Math.max(8, bw * 0.62);
  const fill = toCssColor(seriesColor(opts));

  let bars = "";
  points.forEach((p, i) => {
    const bh = ((h - pad.t - pad.b) * p.value) / max;
    const x = pad.l + i * bw + (bw - barW) / 2;
    const y = h - pad.b - bh;
    // Entire series uses the classification field's color
    const color = opts?.categoryColors?.[i]
      ? toCssColor(opts.categoryColors[i])
      : fill;
    bars += `<rect class="chart-bar" fill="${color}" style="fill:${color}" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3">
      <title>${escapeXml(p.label)}: ${p.value}</title></rect>`;
    bars += `<text class="chart-tick" x="${x + barW / 2}" y="${h - pad.b + 14}" text-anchor="middle">${escapeXml(p.label)}</text>`;
  });

  host.innerHTML = `<div class="chart-title">${escapeXml(title)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
      <line class="chart-axis" x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}" />
      <line class="chart-axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h - pad.b}" />
      ${bars}
    </svg>`;
}

export function renderLineChart(
  host: HTMLElement,
  points: ChartPoint[],
  title: string,
  filled = false,
  opts?: ChartRenderOptions,
): void {
  host.innerHTML = "";
  if (!points.length) {
    host.innerHTML = `<div class="result-empty">No chartable data</div>`;
    return;
  }
  const w = Math.max(480, host.clientWidth || 560);
  const h = 280;
  const pad = { t: 28, r: 16, b: 56, l: 48 };
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = max - min || 1;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const stroke = toCssColor(seriesColor(opts));

  const coords = points.map((p, i) => {
    const x =
      pad.l +
      (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
    const y = pad.t + plotH - ((p.value - min) / span) * plotH;
    return { x, y, p };
  });

  const d = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");

  const areaD =
    filled && coords.length
      ? `${d} L ${coords[coords.length - 1]!.x.toFixed(1)} ${h - pad.b} L ${coords[0]!.x.toFixed(1)} ${h - pad.b} Z`
      : "";

  const dots = coords
    .map(
      (c) =>
        `<circle class="chart-dot" cx="${c.x}" cy="${c.y}" r="4" fill="${stroke}" style="fill:${stroke}"><title>${escapeXml(c.p.label)}: ${c.p.value}</title></circle>
         <text class="chart-tick" x="${c.x}" y="${h - pad.b + 14}" text-anchor="middle">${escapeXml(c.p.label)}</text>`,
    )
    .join("");

  host.innerHTML = `<div class="chart-title">${escapeXml(title)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="--chart-series:${stroke}">
      <line class="chart-axis" x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}" />
      <line class="chart-axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h - pad.b}" />
      ${filled ? `<path class="chart-area" d="${areaD}" fill="${stroke}" fill-opacity="0.22" style="fill:${stroke};fill-opacity:0.22" />` : ""}
      <path class="chart-line" d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5" style="stroke:${stroke};stroke-width:2.5" />
      ${dots}
    </svg>`;
}

export function renderPieChart(
  host: HTMLElement,
  points: ChartPoint[],
  title: string,
  doughnut = false,
  opts?: ChartRenderOptions,
): void {
  host.innerHTML = "";
  if (!points.length) {
    host.innerHTML = `<div class="result-empty">No chartable data</div>`;
    return;
  }
  const total = points.reduce((s, p) => s + p.value, 0) || 1;
  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const r = 100;
  const inner = doughnut ? 52 : 0;

  let angle = -Math.PI / 2;
  const slices: string[] = [];
  const legend: string[] = [];

  points.forEach((p, i) => {
    const slice = (p.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + slice;
    angle = a1;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = slice > Math.PI ? 1 : 0;
    const color = pointColor(i, opts);
    const pct = ((p.value / total) * 100).toFixed(1);

    if (inner > 0) {
      const xi0 = cx + inner * Math.cos(a0);
      const yi0 = cy + inner * Math.sin(a0);
      const xi1 = cx + inner * Math.cos(a1);
      const yi1 = cy + inner * Math.sin(a1);
      slices.push(
        `<path class="chart-slice" style="fill:${color}" d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${inner} ${inner} 0 ${large} 0 ${xi0} ${yi0} Z">
          <title>${escapeXml(p.label)}: ${p.value} (${pct}%)</title></path>`,
      );
    } else {
      slices.push(
        `<path class="chart-slice" style="fill:${color}" d="M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z">
          <title>${escapeXml(p.label)}: ${p.value} (${pct}%)</title></path>`,
      );
    }
    legend.push(
      `<div class="chart-legend-item"><span class="chart-legend-swatch" style="background:${color}"></span>${escapeXml(p.label)} · ${p.value} (${pct}%)</div>`,
    );
  });

  host.innerHTML = `<div class="chart-title">${escapeXml(title)}</div>
    <div class="chart-pie-wrap">
      <svg class="chart-svg chart-pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        ${slices.join("")}
      </svg>
      <div class="chart-legend">${legend.join("")}</div>
    </div>`;
}

export function renderChart(
  host: HTMLElement,
  kind: ChartKind,
  points: ChartPoint[],
  title: string,
  opts?: ChartRenderOptions,
): void {
  switch (kind) {
    case "bar":
      renderBarChart(host, points, title, opts);
      break;
    case "line":
      renderLineChart(host, points, title, false, opts);
      break;
    case "area":
      renderLineChart(host, points, title, true, opts);
      break;
    case "pie":
      renderPieChart(host, points, title, false, opts);
      break;
    case "doughnut":
      renderPieChart(host, points, title, true, opts);
      break;
  }
}
