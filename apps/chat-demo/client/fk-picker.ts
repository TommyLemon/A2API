/** Foreign-key picker: select a row from the target table (no raw id typing). */

import { resolveFkTable } from "./fk-nav.js";
import type { SchemaComments } from "./schema-types.js";

export { resolveFkTable };

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
  title.textContent = opts.title || `选择 ${opts.table}`;
  head.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "detail-back-icon";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  close.onclick = () => modal.remove();
  head.appendChild(close);
  panel.appendChild(head);

  const tip = document.createElement("p");
  tip.className = "hint";
  tip.textContent = "外键必须从关联表选择，不可直接输入 ID。可用条件过滤后点选。";
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
    opts.table === "User" ? "name 包含…" : "content 包含…";
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "primary";
  searchBtn.textContent = "筛选";
  filterRow.append(idInput, kw, searchBtn);
  panel.appendChild(filterRow);

  const list = document.createElement("div");
  list.className = "fk-picker-list";
  list.innerHTML = `<div class="result-empty">加载中…</div>`;
  panel.appendChild(list);

  const load = async () => {
    list.innerHTML = `<div class="result-empty">加载中…</div>`;
    try {
      const body = buildListBody(opts.table, kw.value, idInput.value);
      const res = await fetch(`${opts.apijsonBase.replace(/\/$/, "")}/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { code?: number; msg?: string };
      if (!res.ok || json.code !== 200) {
        list.innerHTML = `<div class="result-empty">加载失败：${json.msg || res.statusText}</div>`;
        return;
      }
      const rows = extractRows(opts.table, json);
      if (!rows.length) {
        list.innerHTML = `<div class="result-empty">无匹配记录</div>`;
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

/** Build a non-editable FK control (display + 选择 button). */
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
    (currentId != null ? `${opts.table}#${currentId}` : "未选择");

  const display = document.createElement("span");
  display.className = "fk-field-display";
  display.textContent = currentLabel;

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "primary";
  pickBtn.textContent = "选择…";
  pickBtn.onclick = () => {
    openFkPicker({
      table: opts.table,
      apijsonBase: opts.apijsonBase,
      comments: opts.comments,
      currentId,
      title: `选择 ${opts.path} → ${opts.table}`,
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
  clearBtn.textContent = "清除";
  clearBtn.disabled = currentId == null;
  clearBtn.onclick = () => {
    currentId = null;
    currentLabel = "未选择";
    display.textContent = currentLabel;
    clearBtn.disabled = true;
    opts.onChange(null, currentLabel);
  };

  host.append(display, pickBtn, clearBtn);
  return {
    getValue: () => currentId,
  };
}
