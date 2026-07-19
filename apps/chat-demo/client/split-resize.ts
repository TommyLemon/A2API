/** Vertical split handle: drag / keyboard to set left pane %. */

export function mountVerticalSplit(opts: {
  split: HTMLElement;
  handle: HTMLElement;
  /** CSS custom property on `split`, e.g. --ui-chat-pct */
  cssVar: string;
  storageKey: string;
  defaultPct?: number;
  minPct?: number;
  maxPct?: number;
  /** class on body while dragging */
  bodyClass?: string;
}): void {
  const min = opts.minPct ?? 20;
  const max = opts.maxPct ?? 80;
  const bodyClass = opts.bodyClass ?? "is-resizing-split";

  const load = (): number => {
    try {
      const n = Number(localStorage.getItem(opts.storageKey));
      if (Number.isFinite(n) && n >= min && n <= max) return n;
    } catch {
      /* ignore */
    }
    return opts.defaultPct ?? 40;
  };

  const save = (pct: number) => {
    try {
      localStorage.setItem(opts.storageKey, String(Math.round(pct)));
    } catch {
      /* ignore */
    }
  };

  const apply = (pct: number) => {
    const clamped = Math.min(max, Math.max(min, pct));
    opts.split.style.setProperty(opts.cssVar, `${clamped}%`);
    save(clamped);
  };

  apply(load());

  let dragging = false;
  const onMove = (clientX: number) => {
    const rect = opts.split.getBoundingClientRect();
    if (rect.width < 80) return;
    apply(((clientX - rect.left) / rect.width) * 100);
  };

  opts.handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    opts.handle.setPointerCapture(e.pointerId);
    document.body.classList.add(bodyClass);
  });
  opts.handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    onMove(e.clientX);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      opts.handle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.remove(bodyClass);
  };
  opts.handle.addEventListener("pointerup", endDrag);
  opts.handle.addEventListener("pointercancel", endDrag);

  opts.handle.addEventListener("keydown", (e) => {
    const cur = load();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      apply(cur - 2);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      apply(cur + 2);
    }
  });
}
