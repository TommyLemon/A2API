/**
 * UI i18n via i18next (bundled resources, sync init).
 * AI reply language stays in Settings.language — separate from UI locale.
 */
import i18next from "i18next";
import { en, type TranslationSchema } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";

export type UiLocale = "en" | "zh-CN";

const UI_LOCALE_KEY = "a2api.uiLocale";

const SUPPORTED: UiLocale[] = ["en", "zh-CN"];

function isUiLocale(v: string | null | undefined): v is UiLocale {
  return v === "en" || v === "zh-CN";
}

/** Detect UI locale: localStorage → navigator → en. */
export function detectUiLocale(): UiLocale {
  try {
    const saved = localStorage.getItem(UI_LOCALE_KEY);
    if (isUiLocale(saved)) return saved;
  } catch {
    /* ignore */
  }
  const nav =
    typeof navigator !== "undefined"
      ? navigator.language || (navigator as { userLanguage?: string }).userLanguage
      : "";
  if (nav && /^zh\b/i.test(nav)) return "zh-CN";
  return "en";
}

export function getUiLocale(): UiLocale {
  const lng = i18next.language;
  return isUiLocale(lng) ? lng : detectUiLocale();
}

/** Persist + change language. Reloads by default so dynamic UI rebuilds cleanly. */
export function setUiLocale(locale: UiLocale, opts?: { reload?: boolean }): void {
  if (!SUPPORTED.includes(locale)) return;
  try {
    localStorage.setItem(UI_LOCALE_KEY, locale);
  } catch {
    /* ignore */
  }
  void i18next.changeLanguage(locale);
  document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  document.title = t("meta.title");
  applyDomI18n(document);
  if (opts?.reload !== false) {
    location.reload();
  }
}

type NestedKeyOf<T, P extends string = ""> = T extends string
  ? P
  : {
      [K in keyof T & string]: NestedKeyOf<
        T[K],
        P extends "" ? K : `${P}.${K}`
      >;
    }[keyof T & string];

export type MsgKey = NestedKeyOf<TranslationSchema>;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: TranslationSchema;
    };
  }
}

const lng = detectUiLocale();

void i18next.init({
  lng,
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

document.documentElement.lang = lng === "zh-CN" ? "zh-CN" : "en";

export const t = i18next.t.bind(i18next) as (
  key: MsgKey,
  options?: Record<string, unknown>,
) => string;

export { i18next };

/**
 * Apply `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` /
 * `data-i18n-aria` / `data-i18n-html` / `data-i18n-msg` on a subtree.
 */
export function applyDomI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n") as MsgKey | null;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html") as MsgKey | null;
    if (key) el.innerHTML = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder") as MsgKey | null;
    if (key && "placeholder" in el) {
      (el as HTMLInputElement).placeholder = t(key);
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title") as MsgKey | null;
    if (key) el.title = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria") as MsgKey | null;
    if (key) el.setAttribute("aria-label", t(key));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-msg]").forEach((el) => {
    const key = el.getAttribute("data-i18n-msg") as MsgKey | null;
    if (key) el.setAttribute("data-msg", t(key));
  });
}

/** Mount language menu on `#locale-toggle` (left of brand mark). */
export function mountLocaleToggle(
  btn: HTMLElement | null = document.getElementById("locale-toggle"),
): void {
  if (!btn || btn.dataset.localeMounted === "1") return;
  btn.dataset.localeMounted = "1";
  btn.setAttribute("aria-label", t("account.uiLanguage"));

  const menu = document.createElement("div");
  menu.className = "vt-locales-menu";
  menu.setAttribute("role", "menu");

  const options: Array<{ locale: UiLocale; labelKey: MsgKey }> = [
    { locale: "en", labelKey: "account.langEn" },
    { locale: "zh-CN", labelKey: "account.langZh" },
  ];

  const renderOptions = () => {
    menu.innerHTML = "";
    const current = getUiLocale();
    for (const opt of options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "vt-locales-menu-item" + (opt.locale === current ? " is-active" : "");
      item.setAttribute("role", "menuitemradio");
      item.setAttribute(
        "aria-checked",
        opt.locale === current ? "true" : "false",
      );
      item.textContent = t(opt.labelKey);
      item.onclick = (e) => {
        e.stopPropagation();
        close();
        if (opt.locale !== getUiLocale()) setUiLocale(opt.locale);
      };
      menu.appendChild(item);
    }
  };

  const close = () => {
    menu.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
  };

  const open = () => {
    renderOptions();
    menu.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
  };

  const wrap = document.createElement("div");
  wrap.className = "vt-locales-wrap";
  btn.replaceWith(wrap);
  wrap.append(btn, menu);

  renderOptions();

  // Click/tap toggles for touch; desktop primarily uses CSS :hover
  btn.onclick = (e) => {
    e.stopPropagation();
    if (menu.classList.contains("is-open")) close();
    else open();
  };

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
}
