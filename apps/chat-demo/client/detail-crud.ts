/**
 * Multi-table detail CRUD: op per table → POST /crud with @get/@post/@put/@delete,
 * plus Request.structure UPDATE refs from Relate options:
 *   "ViceTable": { "UPDATE": { "viceKey@": "/RelateTable/relateKey" } }
 * Also IN / Contains: "id{}@" / "contactIdList<>@".
 * Relate Table / Field / local field are shared with columnMetas (Table DDL).
 */

import { TABLE_FK_EDGES, type FkJoinSpec } from "./fk-expand.js";
import type { ColumnMeta } from "./field-meta.js";
import { stripApiJsonRole } from "./schema-types.js";
import { prioritizeVerifyInStructure } from "./verify-code.js";

export type CrudOp = "get" | "post" | "put" | "delete";

export const CRUD_OP_OPTIONS: ReadonlyArray<{
  op: CrudOp;
  label: string;
  title: string;
}> = [
  { op: "post", label: "Add", title: "Add new" },
  { op: "get", label: "View", title: "View only" },
  { op: "put", label: "Edit", title: "Edit" },
  { op: "delete", label: "Remove", title: "Remove" },
];

/** How vice field links to relate table field (Request.structure UPDATE key suffix). */
export type RelateOp = "eq" | "in" | "contains";

export const RELATE_OP_OPTIONS: ReadonlyArray<{
  op: RelateOp;
  label: string;
  title: string;
  /** APIJSON key suffix before path value */
  keySuffix: string;
}> = [
  {
    op: "eq",
    label: "=",
    title: "Equal: viceKey@ → /RelateTable/relateKey",
    keySuffix: "@",
  },
  {
    op: "in",
    label: "IN",
    title: "IN: id{}@ → /User/contactIdList",
    keySuffix: "{}@",
  },
  {
    op: "contains",
    label: "Contains",
    title: "Contains: contactIdList<>@ → /Comment/userId",
    keySuffix: "<>@",
  },
];

export type DetailTableSlot = {
  /** Stable UI id */
  id: string;
  table: string;
  op: CrudOp;
  /** Shared with ColumnMeta.onTable / FkJoinSpec.onTable */
  relateTable?: string;
  /** Shared with ColumnMeta.onField / FkJoinSpec.onField (remote key, default id) */
  relateField?: string;
  /** Vice-table field in UPDATE (副表.字段) — explicit picker value */
  localField?: string;
  /** = / IN / Contains → @ / {}@ / <>@ */
  relateOp?: RelateOp;
};

export type RelateSyncPayload = {
  table: string;
  localField: string;
  onTable: string;
  onField: string;
  relateOp?: RelateOp;
};

export type CrudWritePayload = {
  method: "put" | "post" | "delete" | "crud";
  body: Record<string, unknown>;
  table: string;
  /** Request.structure fragments (UPDATE field@ …) for Apply / docs */
  structure?: Record<string, unknown>;
};

let slotSeq = 0;
export function newDetailSlotId(): string {
  slotSeq += 1;
  return `dt${slotSeq}`;
}

export function crudOpLabel(op: CrudOp): string {
  return CRUD_OP_OPTIONS.find((o) => o.op === op)?.label ?? op;
}

export function relateOpKeySuffix(op: RelateOp = "eq"): string {
  return (
    RELATE_OP_OPTIONS.find((o) => o.op === op)?.keySuffix ?? "@"
  );
}

/** Local FK column on `table` that points at `relateTable`. */
export function resolveRelateLocalField(
  table: string,
  relateTable: string,
  columnMetas?: Record<string, ColumnMeta> | null,
): string | null {
  if (!table || !relateTable) return null;
  if (columnMetas) {
    for (const [path, meta] of Object.entries(columnMetas)) {
      if (!path.startsWith(`${table}.`)) continue;
      if ((meta.onTable || "").trim() === relateTable) {
        const col = path.slice(table.length + 1);
        if (col && col !== "id") return col;
      }
    }
  }
  const edge = (TABLE_FK_EDGES[table] ?? []).find((e) => e.target === relateTable);
  if (edge) return edge.column;
  const guess =
    relateTable.charAt(0).toLowerCase() + relateTable.slice(1) + "Id";
  return guess;
}

/** Read table-level relate defaults from metas / fkExpand / FK edges. */
export function defaultRelateForTable(
  table: string,
  primaryTable: string | null,
  columnMetas?: Record<string, ColumnMeta> | null,
  fkExpand?: Record<string, FkJoinSpec> | null,
): {
  relateTable: string;
  relateField: string;
  localField: string | null;
  relateOp: RelateOp;
} {
  const spec = fkExpand?.[table];
  if (spec?.onTable) {
    return {
      relateTable: spec.onTable,
      relateField: spec.onField || "id",
      localField: resolveRelateLocalField(table, spec.onTable, columnMetas),
      relateOp: "eq",
    };
  }
  if (columnMetas) {
    for (const [path, meta] of Object.entries(columnMetas)) {
      if (!path.startsWith(`${table}.`)) continue;
      if (meta.onTable) {
        return {
          relateTable: meta.onTable,
          relateField: meta.onField || "id",
          localField: path.slice(table.length + 1),
          relateOp: "eq",
        };
      }
    }
  }
  if (primaryTable && primaryTable !== table) {
    const fromPrimary = (TABLE_FK_EDGES[primaryTable] ?? []).find(
      (e) => e.target === table,
    );
    if (fromPrimary) {
      // JOIN style: secondary.id ↔ primary.fkCol  → id@ /Primary/fkCol
      // For write UPDATE we usually want secondary.fk → primary.id
      const edgeBack = (TABLE_FK_EDGES[table] ?? []).find(
        (e) => e.target === primaryTable,
      );
      if (edgeBack) {
        return {
          relateTable: primaryTable,
          relateField: "id",
          localField: edgeBack.column,
          relateOp: "eq",
        };
      }
      return {
        relateTable: primaryTable,
        relateField: fromPrimary.column,
        localField: "id",
        relateOp: "eq",
      };
    }
    const edge = (TABLE_FK_EDGES[table] ?? []).find(
      (e) => e.target === primaryTable,
    );
    if (edge) {
      return {
        relateTable: primaryTable,
        relateField: "id",
        localField: edge.column,
        relateOp: "eq",
      };
    }
  }
  return {
    relateTable: "",
    relateField: "id",
    localField: null,
    relateOp: "eq",
  };
}

/**
 * structure.UPDATE entry + body field key.
 * Default: "viceKey@": "/RelateTable/relateKey"
 * IN: "id{}@": "/User/contactIdList"
 * Contains: "contactIdList<>@": "/Comment/userId"
 */
export function relateUpdateMap(
  localField: string,
  relateTable: string,
  relateField = "id",
  op: RelateOp = "eq",
): Record<string, string> {
  const remote = relateField.trim() || "id";
  const key = `${localField}${relateOpKeySuffix(op)}`;
  return { [key]: `/${relateTable}/${remote}` };
}

/** Resolve vice field for a slot (explicit localField, else infer). */
export function slotLocalField(
  slot: DetailTableSlot,
  columnMetas?: Record<string, ColumnMeta> | null,
): string | null {
  const explicit = (slot.localField || "").trim();
  if (explicit) return explicit;
  if (!slot.relateTable) return null;
  return resolveRelateLocalField(slot.table, slot.relateTable, columnMetas);
}

export function applyRelateToColumnMetas(
  metas: Record<string, ColumnMeta>,
  payload: RelateSyncPayload,
): Record<string, ColumnMeta> {
  const path = `${payload.table}.${payload.localField}`;
  const prev = metas[path];
  return {
    ...metas,
    [path]: {
      ...(prev ?? {
        path,
        type: "text" as const,
        visible: true,
        filterable: true,
        sortable: true,
      }),
      path,
      onTable: payload.onTable || undefined,
      onField: payload.onField || undefined,
    },
  };
}

/** True when Request cache already has every UPDATE key/path from relateStructure. */
export function relateStructureAlreadyInRequest(
  relateStructure: Record<string, unknown> | undefined,
  lookup: (
    method: string,
    tag: string,
  ) => { structure: Record<string, unknown> } | null,
): boolean {
  if (!relateStructure || !Object.keys(relateStructure).length) return true;
  for (const [table, frag] of Object.entries(relateStructure)) {
    if (!frag || typeof frag !== "object" || Array.isArray(frag)) continue;
    const needed = (frag as Record<string, unknown>).UPDATE;
    if (!needed || typeof needed !== "object" || Array.isArray(needed)) continue;
    const neededMap = needed as Record<string, unknown>;
    if (!Object.keys(neededMap).length) continue;

    let found = false;
    for (const method of ["POST", "PUT", "CRUD"]) {
      const row = lookup(method, table);
      if (!row) continue;
      const nested = row.structure[table];
      const src =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : row.structure;
      const upd = src.UPDATE;
      if (!upd || typeof upd !== "object" || Array.isArray(upd)) continue;
      const have = upd as Record<string, unknown>;
      if (
        Object.entries(neededMap).every(
          ([k, v]) => String(have[k] ?? "") === String(v ?? ""),
        )
      ) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Merge relate UPDATE fragments into a Request.structure draft for Apply.
 * Keeps INSERT/MUST/REFUSE defaults per table when present.
 */
export function mergeStructureForApply(
  relateStructure: Record<string, unknown> | undefined,
  opts: {
    operation: string;
    tables: string[];
    role?: string;
  },
): Record<string, unknown> | undefined {
  if (!relateStructure || !Object.keys(relateStructure).length) {
    return undefined;
  }
  const role = (opts.role || "OWNER").toUpperCase();
  const op = opts.operation.toLowerCase();
  const out: Record<string, unknown> = {};

  const defaultsFor = (table: string): Record<string, unknown> => {
    if (op === "post" || op === "crud") {
      return { INSERT: { "@role": role }, REFUSE: "id" };
    }
    if (op === "put") {
      return {
        MUST: "id",
        INSERT: { "@role": role },
        REFUSE: "userId,date",
      };
    }
    if (op === "delete") {
      return { MUST: "id", INSERT: { "@role": role } };
    }
    return { INSERT: { "@role": role } };
  };

  for (const table of opts.tables) {
    const frag = relateStructure[table];
    // Verify is consumed via @delete — keep UPDATE / @delete, no OWNER INSERT
    if (table === "Verify") {
      if (frag && typeof frag === "object" && !Array.isArray(frag)) {
        out[table] = { ...(frag as Record<string, unknown>) };
      }
      continue;
    }
    const base = defaultsFor(table);
    if (frag && typeof frag === "object" && !Array.isArray(frag)) {
      const f = frag as Record<string, unknown>;
      out[table] = {
        ...base,
        ...f,
        UPDATE: {
          ...(typeof base.UPDATE === "object" && base.UPDATE
            ? (base.UPDATE as Record<string, unknown>)
            : {}),
          ...(typeof f.UPDATE === "object" && f.UPDATE
            ? (f.UPDATE as Record<string, unknown>)
            : {}),
        },
      };
    } else {
      out[table] = base;
    }
  }

  // Include any extra tables from relateStructure not in opts.tables
  for (const [table, frag] of Object.entries(relateStructure)) {
    if (out[table]) continue;
    if (frag && typeof frag === "object" && !Array.isArray(frag)) {
      out[table] =
        table === "Verify"
          ? { ...(frag as Record<string, unknown>) }
          : {
              ...defaultsFor(table),
              ...(frag as Record<string, unknown>),
            };
    }
  }

  return prioritizeVerifyInStructure(out);
}

/**
 * Build single-table or multi-table write payload.
 * Multi / mixed ops → method "crud" with @get/@post/@put/@delete.
 */
export function buildCrudPayload(opts: {
  slots: DetailTableSlot[];
  /** table → entity fields (no @ keys yet) */
  entities: Record<string, Record<string, unknown>>;
  columnMetas?: Record<string, ColumnMeta> | null;
  /** When true, inject field@ and omit concrete FK value on secondary writes */
  injectRelateRefs?: boolean;
}): CrudWritePayload | null {
  const slots = opts.slots.filter((s) => s.table);
  if (!slots.length) return null;

  const inject = opts.injectRelateRefs !== false;
  const body: Record<string, unknown> = {};
  const structure: Record<string, unknown> = {};
  const groups: Record<CrudOp, string[]> = {
    get: [],
    post: [],
    put: [],
    delete: [],
  };

  const primary = slots[0]!;

  for (const slot of slots) {
    const table = slot.table;
    groups[slot.op].push(table);
    const raw = { ...(opts.entities[table] ?? {}) };
    const entity: Record<string, unknown> = { ...raw };

    const isSecondary = slot.id !== primary.id && table !== primary.table;
    if (
      inject &&
      isSecondary &&
      slot.relateTable &&
      (slot.op === "post" || slot.op === "put")
    ) {
      const local = slotLocalField(slot, opts.columnMetas);
      const remote = slot.relateField?.trim() || "id";
      const relateOp = slot.relateOp || "eq";
      if (local) {
        // Strip concrete value for the vice key (and bare name without suffix)
        delete entity[local];
        for (const k of Object.keys(entity)) {
          if (k === `${local}@` || k === `${local}{}@` || k === `${local}<>@`) {
            delete entity[k];
          }
        }
        const upd = relateUpdateMap(
          local,
          slot.relateTable,
          remote,
          relateOp,
        );
        Object.assign(entity, upd);
        structure[table] = {
          UPDATE: upd,
        };
      }
    }

    if (slot.op === "delete") {
      const id = entity.id;
      if (id == null || id === "") continue;
      body[table] = { id };
    } else if (slot.op === "get") {
      if (entity.id != null && entity.id !== "") {
        body[table] = { id: entity.id };
      } else {
        body[table] = entity;
      }
    } else {
      body[table] = entity;
    }
  }

  const usedOps = (["get", "post", "put", "delete"] as CrudOp[]).filter(
    (o) => groups[o].length > 0,
  );
  if (!usedOps.length) return null;

  const structureOut = Object.keys(structure).length
    ? structure
    : undefined;

  // Single table, single write op → /post|/put|/delete
  if (slots.length === 1 && usedOps.length === 1 && usedOps[0] !== "get") {
    const method = usedOps[0]! as "post" | "put" | "delete";
    const table = slots[0]!.table;
    const entity = body[table];
    if (entity == null || typeof entity !== "object") return null;
    return {
      method,
      table,
      body: stripApiJsonRole({ [table]: entity, tag: table }),
      structure: structureOut,
    };
  }

  // Multi-table / mixed ops → always POST /crud with @get/@post/@put/@delete
  for (const op of usedOps) {
    body[`@${op}`] = groups[op].join(",");
  }

  return {
    method: "crud",
    table: primary.table,
    body: stripApiJsonRole(body),
    structure: structureOut,
  };
}

/** Sensitive write op for gate (delete > put > post). */
export function crudGateMethod(
  slots: DetailTableSlot[],
): "post" | "put" | "delete" | null {
  const ops = new Set(slots.map((s) => s.op));
  if (ops.has("delete")) return "delete";
  if (ops.has("put")) return "put";
  if (ops.has("post")) return "post";
  return null;
}
