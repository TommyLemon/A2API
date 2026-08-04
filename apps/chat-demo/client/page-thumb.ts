/**
 * Capture a JPEG of the workspace (#results) for the page-switcher grid.
 * Leave-page captures are critical (must finish before DOM swap); stay-on-page
 * saves are debounced; after-switch captures refresh the new page thumb.
 */

import { toJpeg } from "html-to-image";
import { isValidPageThumb, setSavedPageThumb } from "./saved-pages.js";

const CAPTURE_SEL = "#results";
const FALLBACK_SEL = "#result-view";
const THUMB_W = 364;
const THUMB_H = 218;

let captureSeq = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export type PageThumbSavedHandler = (pageId: string) => void;
let onThumbSaved: PageThumbSavedHandler | null = null;

/** UI hook: refresh the page-picker grid when a thumb is written. */
export function setPageThumbSavedHandler(handler: PageThumbSavedHandler | null) {
  onThumbSaved = handler;
}

function notifyThumbSaved(pageId: string) {
  try {
    onThumbSaved?.(pageId);
  } catch {
    /* ignore UI refresh errors */
  }
}

function bgColor(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  return v || "#0f1419";
}

function includeNode(node: HTMLElement): boolean {
  const skip = [
    "page-menu",
    "page-picker-menu",
    "img-lightbox",
    "ddl-popover",
    "filter-popover",
    "account-menu",
  ];
  for (const c of skip) {
    if (node.classList?.contains(c)) return false;
  }
  return true;
}

function captureTarget(): HTMLElement | null {
  const primary = document.querySelector(CAPTURE_SEL) as HTMLElement | null;
  if (primary && primary.getBoundingClientRect().width >= 16) return primary;
  const fallback = document.querySelector(FALLBACK_SEL) as HTMLElement | null;
  if (fallback && fallback.getBoundingClientRect().width >= 16) return fallback;
  return primary ?? fallback;
}

/** Screenshot the workspace result area as a compact JPEG data URL. */
export async function captureWorkspaceThumb(): Promise<string | null> {
  const node = captureTarget();
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 16 || rect.height < 16) return null;

  const srcW = Math.max(16, Math.floor(rect.width));
  const aspect = THUMB_H / THUMB_W;
  const srcH = Math.max(
    16,
    Math.floor(Math.min(rect.height, srcW * aspect)),
  );

  try {
    const dataUrl = await toJpeg(node, {
      quality: 0.62,
      pixelRatio: 1,
      width: srcW,
      height: srcH,
      canvasWidth: THUMB_W,
      canvasHeight: THUMB_H,
      backgroundColor: bgColor(),
      cacheBust: false,
      filter: (n) => {
        if (!(n instanceof HTMLElement)) return true;
        return includeNode(n);
      },
    });
    return isValidPageThumb(dataUrl) ? dataUrl : null;
  } catch {
    return null;
  }
}

export function cancelPageThumbCapture() {
  captureSeq += 1;
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export type CaptureThumbOpts = {
  /**
   * Leave-page snapshot before DOM swap. Ignores cancel/seq so a slow
   * html-to-image cannot be discarded mid-flight (caller must await before
   * mutating #results).
   */
  critical?: boolean;
};

/**
 * Capture now and store under pageId.
 * Non-critical captures bump captureSeq and abort if superseded.
 */
export async function captureAndSavePageThumb(
  pageId: string | null | undefined,
  opts?: CaptureThumbOpts,
): Promise<boolean> {
  if (!pageId) return false;
  const critical = !!opts?.critical;
  let seq = 0;
  if (critical) {
    // Drop deferred stay-on-page jobs only — do not bump seq (that would
    // invalidate this critical capture if cancel raced).
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  } else {
    seq = ++captureSeq;
  }
  const dataUrl = await captureWorkspaceThumb();
  if (!critical && seq !== captureSeq) return false;
  if (!dataUrl) return false;
  const ok = setSavedPageThumb(pageId, dataUrl);
  if (ok) notifyThumbSaved(pageId);
  return ok;
}

/** Debounced capture after a stay-on-page save (layout / filter persist). */
export function schedulePageThumbCapture(
  pageId: string | null | undefined,
  delayMs = 450,
) {
  if (!pageId) return;
  const seq = ++captureSeq;
  if (pendingTimer != null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void (async () => {
      if (seq !== captureSeq) return;
      const dataUrl = await captureWorkspaceThumb();
      if (seq !== captureSeq) return;
      if (!dataUrl) return;
      if (setSavedPageThumb(pageId, dataUrl)) notifyThumbSaved(pageId);
    })();
  }, delayMs);
}

/**
 * After switching to a page: always re-capture once the target area has painted;
 * on success replace any existing thumb.
 * `stillActive` aborts if the user has already left this page.
 */
export async function capturePageThumbAfterSwitch(
  pageId: string | null | undefined,
  stillActive?: () => boolean,
): Promise<boolean> {
  if (!pageId) return false;
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
  if (stillActive && !stillActive()) return false;
  await new Promise((r) => setTimeout(r, 350));
  if (stillActive && !stillActive()) return false;
  return captureAndSavePageThumb(pageId);
}
