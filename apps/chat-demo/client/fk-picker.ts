/** Foreign-key picker: select a row (or many) from the target table. */

import { resolveFkIdListTable, resolveFkTable } from "./fk-nav.js";
import { withRequestRole } from "./access-roles.js";
import type { SchemaComments } from "./schema-types.js";

export { resolveFkTable, resolveFkIdListTable };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

function labelForRow(
  table: string,
  row: Record<string, unknown>,
): string {
  const name = row.name ?? row.content ?? row.tag ?? row.title;
  const id = row.id;
  if (name != null && String(name)) {
    return `${table}#${id} · ${String(name).slice(0, 40)}`;
  }
  return `${table}#${id}`;
}

function buildListBody(
  table: string,
  keyword: string,
  idEq: string,
): Record<string, unknown> {
  const entity: Record<string, unknown> = {};
  const idRaw = idEq.trim();
  if (idRaw && /^-?\d+$/.test(idRaw)) {
    entity.id = Number(idRaw);
  }
  const kw = keyword.trim();
  if (kw) {
    if (table === "User") entity["name$"] = `%${kw}%`;
    else if (table === "Moment" || table === "Comment") {
      entity["content$"] = `%${kw}%`;
    }
  }
  return {
    "[]": {
      count: 20,
      page: 0,
      [table]: entity,
    },
  };
}

function extractRows(
  table: string,
  response: unknown,
): Array<Record<string, unknown>> {
  if (!isPlainObject(response)) return [];
  const arr = response["[]"];
  if (!Array.isArray(arr)) {
    const one = response[table];
    return isPlainObject(one) ? [one] : [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of arr) {
    if (!isPlainObject(item)) continue;
    const ent = item[table];
    if (isPlainObject(ent)) out.push(ent);
    else if (item.id != null) out.push(item);
  }
  return out;
}

export type FkPickResult = {
  id: string | number;
  label: string;
  row: Record<string, unknown>;
};

/**
 * Modal: search/filter FK table rows and pick one.
 */
export function openFkPicker(opts: {
  table: string;
  apijsonBase: string;
  comments?: SchemaComments | null;
  currentId?: string | number | null;
  title?: string;
  onSelect: (picked: FkPickResult) => void;
}): void {
  document.getElementById("fk-picker-modal")?.remove();

  const modal = document.createElement("div");
  modal.id = "fk-picker-modal";
  modal.className = "fk-picker-modal";

  const panel = document.createElement("div");
  panel.className = "fk-picker-panel";

  const head = document.createElement("div");
  head.className = "fk-picker-head";
  const title = document.createElement("h3");
  title.textContent = opts.title || `Select ${opts.table}`;
  head.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-back-icon";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.onclick = () => modal.remove();
  head.appendChild(close);
  panel.appendChild(head);

  const tip = document.createElement("p");
  tip.className = "hint";
  tip.textContent = "Foreign keys must be chosen from the related table, not typed as raw IDs. Filter and pick a row.";
  panel.appendChild(tip);

  const filterRow = document.createElement("div");
  filterRow.className = "fk-picker-filters";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.inputMode = "numeric";
  idInput.placeholder = "id =";
  idInput.style.maxWidth = "6rem";
  const kw = document.createElement("input");
  kw.type = "text";
  kw.placeholder =
    opts.table === "User" ? "name contains…" : "content contains…";
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "primary";
  searchBtn.textContent = "Filter";
  filterRow.append(idInput, kw, searchBtn);
  panel.appendChild(filterRow);

  const list = document.createElement("div");
  list.className = "fk-picker-list";
  list.innerHTML = `<div class="result-empty">Loading…</div>`;
  panel.appendChild(list);

  const load = async () => {
    list.innerHTML = `<div class="result-empty">Loading…</div>`;
    try {
      const body = await withRequestRole(
        buildListBody(opts.table, kw.value, idInput.value),
        "get",
        opts.apijsonBase,
      );
      const res = await fetch(`${opts.apijsonBase.replace(/\/$/, "")}/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { code?: number; msg?: string };
      if (!res.ok || json.code !== 200) {
        list.innerHTML = `<div class="result-empty">Load failed: ${json.msg || res.statusText}</div>`;
        return;
      }
      const rows = extractRows(opts.table, json);
      if (!rows.length) {
        list.innerHTML = `<div class="result-empty">No matching records</div>`;
        return;
      }
      list.innerHTML = "";
      for (const row of rows) {
        const id = row.id as string | number;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "fk-picker-item" +
          (String(id) === String(opts.currentId ?? "") ? " selected" : "");
        btn.textContent = labelForRow(opts.table, row);
        btn.onclick = () => {
          opts.onSelect({
            id,
            label: labelForRow(opts.table, row),
            row,
          });
          modal.remove();
        };
        list.appendChild(btn);
      }
    } catch (e) {
      list.innerHTML = `<div class="result-empty">${e instanceof Error ? e.message : String(e)}</div>`;
    }
  };

  searchBtn.onclick = () => void load();
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void load();
    }
  };
  kw.addEventListener("keydown", onEnter);
  idInput.addEventListener("keydown", onEnter);

  modal.appendChild(panel);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  void load();
  kw.focus();
}

/** Build a non-editable FK control (display + Select button). */
export function mountFkFieldControl(
  host: HTMLElement,
  opts: {
    path: string;
    table: string;
    apijsonBase: string;
    comments?: SchemaComments | null;
    initialId?: string | number | null;
    initialLabel?: string;
    onChange: (id: string | number | null, label: string) => void;
  },
): { getValue: () => string | number | null } {
  host.innerHTML = "";
  host.classList.add("fk-field-control");

  let currentId: string | number | null =
    opts.initialId === "" || opts.initialId == null ? null : opts.initialId;
  let currentLabel =
    opts.initialLabel ||
    (currentId != null ? `${opts.table}#${currentId}` : "Not selected");

  const display = document.createElement("span");
  display.className = "fk-field-display";
  display.textContent = currentLabel;

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "primary";
  pickBtn.textContent = "Select…";
  pickBtn.onclick = () => {
    openFkPicker({
      table: opts.table,
      apijsonBase: opts.apijsonBase,
      comments: opts.comments,
      currentId,
      title: `Select ${opts.path} → ${opts.table}`,
      onSelect: (picked) => {
        currentId = picked.id;
        currentLabel = picked.label;
        display.textContent = currentLabel;
        clearBtn.disabled = false;
        opts.onChange(currentId, currentLabel);
      },
    });
  };

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.disabled = currentId == null;
  clearBtn.onclick = () => {
    currentId = null;
    currentLabel = "Not selected";
    display.textContent = currentLabel;
    clearBtn.disabled = true;
    opts.onChange(null, currentLabel);
  };

  host.append(display, pickBtn, clearBtn);
  return {
    getValue: () => currentId,
  };
}

function parseIdList(value: unknown): Array<string | number> {
  if (Array.isArray(value)) {
    const out: Array<string | number> = [];
    for (const v of value) {
      if (typeof v === "number" && Number.isFinite(v)) out.push(v);
      else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
        out.push(Number(v.trim()));
      }
    }
    return out;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return parseIdList(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Multi-select FK modal: toggle rows, then Done.
 */
export function openFkMultiPicker(opts: {
  table: string;
  apijsonBase: string;
  comments?: SchemaComments | null;
  selectedIds?: Array<string | number>;
  title?: string;
  onDone: (picked: FkPickResult[]) => void;
}): void {
  document.getElementById("fk-picker-modal")?.remove();

  const selected = new Map<string, FkPickResult>();
  for (const id of opts.selectedIds ?? []) {
    selected.set(String(id), {
      id,
      label: `${opts.table}#${id}`,
      row: { id },
    });
  }

  const modal = document.createElement("div");
  modal.id = "fk-picker-modal";
  modal.className = "fk-picker-modal";

  const panel = document.createElement("div");
  panel.className = "fk-picker-panel";

  const head = document.createElement("div");
  head.className = "fk-picker-head";
  const title = document.createElement("h3");
  title.textContent = opts.title || `Select ${opts.table} (multi)`;
  head.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-back-icon";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.onclick = () => modal.remove();
  head.appendChild(close);
  panel.appendChild(head);

  const tip = document.createElement("p");
  tip.className = "hint";
  tip.textContent =
    "This field is a foreign-key id list. Toggle rows to add/remove, then Done.";
  panel.appendChild(tip);

  const filterRow = document.createElement("div");
  filterRow.className = "fk-picker-filters";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.inputMode = "numeric";
  idInput.placeholder = "id =";
  idInput.style.maxWidth = "6rem";
  const kw = document.createElement("input");
  kw.type = "text";
  kw.placeholder =
    opts.table === "User" ? "name contains…" : "content contains…";
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "primary";
  searchBtn.textContent = "Filter";
  filterRow.append(idInput, kw, searchBtn);
  panel.appendChild(filterRow);

  const list = document.createElement("div");
  list.className = "fk-picker-list";
  list.innerHTML = `<div class="result-empty">Loading…</div>`;
  panel.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "fk-picker-footer";
  const summary = document.createElement("span");
  summary.className = "muted";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "primary";
  doneBtn.textContent = "Done";
  const syncSummary = () => {
    summary.textContent = `${selected.size} selected`;
  };
  syncSummary();
  doneBtn.onclick = () => {
    opts.onDone([...selected.values()]);
    modal.remove();
  };
  footer.append(summary, doneBtn);
  panel.appendChild(footer);

  const load = async () => {
    list.innerHTML = `<div class="result-empty">Loading…</div>`;
    try {
      const body = await withRequestRole(
        buildListBody(opts.table, kw.value, idInput.value),
        "get",
        opts.apijsonBase,
      );
      const res = await fetch(`${opts.apijsonBase.replace(/\/$/, "")}/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { code?: number; msg?: string };
      if (!res.ok || json.code !== 200) {
        list.innerHTML = `<div class="result-empty">Load failed: ${json.msg || res.statusText}</div>`;
        return;
      }
      const rows = extractRows(opts.table, json);
      if (!rows.length) {
        list.innerHTML = `<div class="result-empty">No matching records</div>`;
        return;
      }
      list.innerHTML = "";
      for (const row of rows) {
        const id = row.id as string | number;
        const key = String(id);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "fk-picker-item" + (selected.has(key) ? " selected" : "");
        btn.textContent = labelForRow(opts.table, row);
        btn.onclick = () => {
          if (selected.has(key)) selected.delete(key);
          else {
            selected.set(key, {
              id,
              label: labelForRow(opts.table, row),
              row,
            });
          }
          btn.classList.toggle("selected", selected.has(key));
          syncSummary();
        };
        list.appendChild(btn);
      }
    } catch (e) {
      list.innerHTML = `<div class="result-empty">${e instanceof Error ? e.message : String(e)}</div>`;
    }
  };

  searchBtn.onclick = () => void load();
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void load();
    }
  };
  kw.addEventListener("keydown", onEnter);
  idInput.addEventListener("keydown", onEnter);

  modal.appendChild(panel);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
  void load();
  kw.focus();
}

/**
 * Multi FK id-list control (e.g. praiseUserIdList → User[]).
 * Keeps a hidden JSON textarea for form submit compatibility.
 */
export function mountFkIdListControl(
  host: HTMLElement,
  opts: {
    path: string;
    table: string;
    apijsonBase: string;
    comments?: SchemaComments | null;
    initialIds?: unknown;
    editable?: boolean;
    registerInput?: (
      el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    ) => void;
    onChange?: (ids: Array<string | number>) => void;
  },
): { getValue: () => Array<string | number> } {
  host.innerHTML = "";
  host.classList.add("fk-idlist-control");

  let items: FkPickResult[] = parseIdList(opts.initialIds).map((id) => ({
    id,
    label: `${opts.table}#${id}`,
    row: { id },
  }));

  const hidden = document.createElement("textarea");
  hidden.className = "hidden";
  hidden.dataset.path = opts.path;
  hidden.dataset.kind = "json";
  hidden.readOnly = true;

  const chips = document.createElement("div");
  chips.className = "fk-idlist-chips";

  const sync = () => {
    const ids = items.map((i) => i.id);
    hidden.value = JSON.stringify(ids);
    chips.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = opts.editable === false ? "None" : "No users selected";
      chips.appendChild(empty);
    } else {
      for (const item of items) {
        const chip = document.createElement("span");
        chip.className = "fk-idlist-chip";
        chip.textContent = item.label;
        chip.title = String(item.id);
        if (opts.editable !== false) {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "fk-idlist-chip-x";
          rm.textContent = "×";
          rm.title = "Remove";
          rm.onclick = () => {
            items = items.filter((x) => String(x.id) !== String(item.id));
            sync();
            opts.onChange?.(items.map((i) => i.id));
          };
          chip.appendChild(rm);
        }
        chips.appendChild(chip);
      }
    }
  };

  const actions = document.createElement("div");
  actions.className = "fk-idlist-actions";
  if (opts.editable !== false) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "primary";
    addBtn.textContent = `Select ${opts.table}…`;
    addBtn.onclick = () => {
      openFkMultiPicker({
        table: opts.table,
        apijsonBase: opts.apijsonBase,
        comments: opts.comments,
        selectedIds: items.map((i) => i.id),
        title: `${opts.path} → ${opts.table}.id[]`,
        onDone: (picked) => {
          items = picked;
          sync();
          opts.onChange?.(items.map((i) => i.id));
        },
      });
    };
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = () => {
      items = [];
      sync();
      opts.onChange?.([]);
    };
    actions.append(addBtn, clearBtn);
  }

  host.append(chips, actions, hidden);
  if (opts.registerInput) opts.registerInput(hidden);
  sync();

  // Best-effort: resolve labels for initial ids
  if (items.length && opts.apijsonBase) {
    void (async () => {
      try {
        const ids = items.map((i) => i.id);
        const body = await withRequestRole(
          {
            "[]": {
              count: Math.min(100, Math.max(ids.length, 1)),
              [opts.table]: { "id{}": ids },
            },
          },
          "get",
          opts.apijsonBase,
        );
        const res = await fetch(
          `${opts.apijsonBase.replace(/\/$/, "")}/get`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            credentials: "include",
            body: JSON.stringify(body),
          },
        );
        const json = await res.json();
        const rows = extractRows(opts.table, json);
        const byId = new Map(
          rows.map((r) => [String(r.id), labelForRow(opts.table, r)]),
        );
        let changed = false;
        items = items.map((it) => {
          const label = byId.get(String(it.id));
          if (label && label !== it.label) {
            changed = true;
            return { ...it, label };
          }
          return it;
        });
        if (changed) sync();
      } catch {
        /* keep id labels */
      }
    })();
  }

  return {
    getValue: () => items.map((i) => i.id),
  };
}
