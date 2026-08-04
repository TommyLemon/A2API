/**
 * APIAuto-style account + AI settings (top-right Login / Settings).
 * Credentials & API keys stay in localStorage; LLM overrides go with chat/analyze.
 */

import { withRequestRole } from "./access-roles.js";
import {
  APIJSON_BROWSER_BASE,
  isLegacyDirectApijsonBase,
} from "./aj-base.js";
import { clearApijsonBffSession, withApijsonAuth } from "./aj-auth.js";
import { getUiLocale, setUiLocale, t, type UiLocale } from "./i18n/index.js";
import { stripApiJsonRole, withLoginDefaults } from "./schema-types.js";

type SessionUi = {
  refresh: () => void;
  openLogin: () => void;
};

let sessionUi: SessionUi | null = null;
let lastSessionLogoutAt = 0;

export function registerSessionUi(ui: SessionUi): void {
  sessionUi = ui;
}

/**
 * Clear local account + prompt Login when APIJSON outermost `code` is 401.
 * No-op UI if already logged out. Returns true when code === 401.
 */
export function logoutIfApijsonAuthFailed(json: {
  code?: unknown;
} | null | undefined): boolean {
  if (!json || json.code !== 401) return false;

  const hadAccount = Boolean(loadAccount());
  if (hadAccount) {
    saveAccount(null);
    document.getElementById("account-quick")?.remove();
    void import("./aj-auth.js").then((m) => m.clearApijsonBffSession());
    sessionUi?.refresh();
    const now = Date.now();
    if (now - lastSessionLogoutAt > 2000) {
      lastSessionLogoutAt = now;
      sessionUi?.openLogin();
    }
  }
  return true;
}

export type AccountUser = {
  /** Display label — must be User.name when known (never phone/id). */
  name: string;
  /** Login account (often phone), kept for remember / re-auth */
  login?: string;
  userId?: string | number;
  password?: string;
  email?: string;
  /** Vendor admin only — unlocks Admin approvals tab */
  role?: "user" | "admin";
  remember?: boolean;
};

function looksLikePhoneOrId(s: string): boolean {
  return /^\d{5,}$/.test(s.trim());
}

function isUsableDisplayName(s: string): boolean {
  const trimmed = s.trim();
  return Boolean(trimmed) && !looksLikePhoneOrId(trimmed);
}

/** Demo gate: Admin tab for vendor admins (name admin/vendor, or role=admin). */
export function isAdminUser(user: AccountUser | null = loadAccount()): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const keys = [user.name, user.login].filter(Boolean).map((s) =>
    String(s).trim().toLowerCase(),
  );
  return keys.some((n) => n === "admin" || n === "vendor");
}

type UserRow = {
  name?: string;
  id?: number | string;
  phone?: number | string;
  email?: string;
};

/** APIJSON /login returns lowercase `user`; some builds use `User`. */
function pickLoginUser(
  data: Record<string, unknown> | null | undefined,
): UserRow | undefined {
  if (!data) return undefined;
  const u = data.user ?? data.User;
  if (u && typeof u === "object" && !Array.isArray(u)) return u as UserRow;
  return undefined;
}

function pickUserName(u: UserRow | null | undefined): string {
  if (!u) return "";
  return String(u.name ?? "").trim();
}

function pickUserId(data: Record<string, unknown> | null): string | number | null {
  if (!data) return null;
  const u = pickLoginUser(data);
  if (u?.id != null && u.id !== "") return u.id;
  const top =
    data.userId ?? data.userid ?? data.visitorId ?? data.visitorid;
  if (top != null && top !== "") return top as string | number;
  return null;
}

/** User table has id/name/… — not phone/email (those live on Privacy). */
const USER_NAME_COLUMNS = "id,name";

/** APIJSON Demo login uses top-level phone/password (not nested under User). */
async function apijsonLogin(
  base: string,
  account: string,
  password: string,
): Promise<Record<string, unknown> | null> {
  const payloads: unknown[] = looksLikePhoneOrId(account)
    ? [
        { phone: account, password },
        { phone: Number(account), password },
        { User: { phone: account, password } },
      ]
    : [
        { User: { name: account, password } },
        { phone: account, password },
      ];

  for (const body of payloads) {
    try {
      const res = await fetch(
        `${base}/login`,
        withApijsonAuth({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            withLoginDefaults(body as Record<string, unknown>),
          ),
        }),
      );
      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!data) continue;
      const code = data.code;
      if (code === 200 || code === 0 || code == null) return data;
      // Some demos omit code on success when User is present
      if (data.User || data.user || data.userId != null) return data;
    } catch {
      /* try next shape */
    }
  }
  return null;
}

async function fetchUserById(
  base: string,
  id: string | number,
): Promise<UserRow | null> {
  try {
    const res = await fetch(
      `${base}/get`,
      withApijsonAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          await withRequestRole(
            { User: { id, "@column": USER_NAME_COLUMNS } },
            "get",
            base,
          ),
        ),
      }),
    );
    const data = (await res.json().catch(() => null)) as {
      User?: UserRow;
      code?: number;
    } | null;
    if (data?.User && (data.code === 200 || data.code === 0 || data.code == null)) {
      return data.User;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function fetchUserByPhone(
  base: string,
  phone: string,
): Promise<UserRow | null> {
  // Demo phones map to User.id via last 5 digits (13000082001 → 82001)
  if (/^\d{11}$/.test(phone)) {
    const shortId = Number(phone.slice(-5));
    if (shortId > 0) {
      const byId = await fetchUserById(base, shortId);
      if (byId) return byId;
    }
  }
  return null;
}

/** Resolve display label from /login `user.name` (fallback: GET User by id). */
async function resolveDisplayProfile(
  base: string,
  account: string,
  loginData: Record<string, unknown> | null,
): Promise<{ name: string; userId?: string | number; email?: string }> {
  const loginUser = pickLoginUser(loginData);
  const userId = pickUserId(loginData) ?? loginUser?.id ?? undefined;
  const fromLogin = pickUserName(loginUser);

  // Primary: /login returns `{ user: { id, name, … } }` — use name as-is.
  if (fromLogin) {
    return {
      name: fromLogin,
      userId: userId ?? undefined,
      email: loginUser?.email ? String(loginUser.email).trim() || undefined : undefined,
    };
  }

  let profile: UserRow | null = null;
  if (userId != null) profile = await fetchUserById(base, userId);
  if (!profile && looksLikePhoneOrId(account)) {
    profile = await fetchUserByPhone(base, account);
  }
  const resolved = pickUserName(profile);
  if (resolved) {
    return {
      name: resolved,
      userId: profile?.id ?? userId ?? undefined,
      email: profile?.email ? String(profile.email) : undefined,
    };
  }
  // Last resort: typed username (not phone/id). Never show bare numeric id as label.
  if (isUsableDisplayName(account)) {
    return { name: account, userId: userId ?? undefined };
  }
  return {
    name: account,
    userId: profile?.id ?? userId ?? undefined,
    email: profile?.email ? String(profile.email) : undefined,
  };
}

export type AiSettings = {
  model: string;
  baseUrl: string;
  apiKey: string;
  language: string;
  /** Same-origin /apijson proxy (or absolute APIJSON URL override) */
  apijsonBaseUrl: string;
};

const ACCOUNT_KEY = "a2api.account";
const SETTINGS_KEY = "a2api.settings";
const REMEMBER_KEY = "a2api.remember";

const DEFAULT_SETTINGS: AiSettings = {
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  language: "en",
  apijsonBaseUrl: APIJSON_BROWSER_BASE,
};

export function loadAccount(): AccountUser | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as AccountUser;
    return u?.name ? u : null;
  } catch {
    return null;
  }
}

export function saveAccount(user: AccountUser | null): void {
  if (!user) localStorage.removeItem(ACCOUNT_KEY);
  else localStorage.setItem(ACCOUNT_KEY, JSON.stringify(user));
}

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const merged = {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(raw) as Partial<AiSettings>),
    };
    if (isLegacyDirectApijsonBase(merged.apijsonBaseUrl || "")) {
      merged.apijsonBaseUrl = APIJSON_BROWSER_BASE;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AiSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** Payload sent to server LLM endpoints (omit empty apiKey so env can apply). */
export function llmConfigForApi(s: AiSettings = loadSettings()) {
  return {
    model: s.model || undefined,
    baseUrl: s.baseUrl || undefined,
    apiKey: s.apiKey?.trim() || undefined,
    language: s.language || undefined,
  };
}

function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return t("common.clickToSet");
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

function truncate(s: string, n = 42): string {
  const trimmed = s.trim();
  if (!trimmed) return t("common.dash");
  return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}

export function mountAccountUi(opts: {
  headerEl: HTMLElement;
  metaEl?: HTMLElement | null;
  onSettingsChange?: (s: AiSettings) => void;
  onAccountChange?: () => void;
}): { refresh: () => void } {
  // Prefer static slot in index.html so Login/Settings always render even if JS is stale
  let wrap =
    (document.getElementById("account-root") as HTMLElement | null) ||
    (opts.headerEl.querySelector(".account-wrap") as HTMLElement | null);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "account-wrap";
    wrap.id = "account-root";
    if (opts.metaEl) opts.headerEl.insertBefore(wrap, opts.metaEl);
    else opts.headerEl.appendChild(wrap);
  }

  let loginBtn = document.getElementById(
    "account-login-btn",
  ) as HTMLButtonElement | null;
  if (!loginBtn) {
    loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = "account-link";
    loginBtn.id = "account-login-btn";
    loginBtn.textContent = t("account.login");
    wrap.appendChild(loginBtn);
  }

  let settingsBtn = document.getElementById(
    "account-settings-btn",
  ) as HTMLButtonElement | null;
  if (!settingsBtn) {
    settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "account-link";
    settingsBtn.id = "account-settings-btn";
    settingsBtn.textContent = t("account.settings");
    wrap.appendChild(settingsBtn);
  }

  let settingsWrap = wrap.querySelector(
    ".account-settings-wrap",
  ) as HTMLElement | null;
  if (!settingsWrap) {
    settingsWrap = document.createElement("div");
    settingsWrap.className = "account-settings-wrap";
    settingsBtn.replaceWith(settingsWrap);
    settingsWrap.appendChild(settingsBtn);
  } else if (!settingsWrap.contains(settingsBtn)) {
    settingsWrap.appendChild(settingsBtn);
  }

  let menu = document.getElementById("account-menu") as HTMLElement | null;
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "account-menu";
    menu.id = "account-menu";
    settingsWrap.appendChild(menu);
  } else {
    menu.classList.remove("hidden");
    if (!settingsWrap.contains(menu)) settingsWrap.appendChild(menu);
  }

  const closeMenu = () => menu!.classList.remove("is-open");
  const openMenu = () => {
    renderSettingsMenu(menu!, {
      onClose: closeMenu,
      onSettingsChange: opts.onSettingsChange,
      openAuth: (mode) => openAuthModal(mode, refresh),
      refreshAccount: refresh,
    });
    menu!.classList.add("is-open");
  };

  const refresh = () => {
    const user = loadAccount();
    // JS owns this label (user.name from /login) — drop data-i18n so applyDomI18n
    // cannot overwrite a signed-in name with the static "Login" string.
    loginBtn!.removeAttribute("data-i18n");
    loginBtn!.textContent = user?.name || t("account.login");
    loginBtn!.title = user?.name
      ? t("account.account")
      : t("account.loginRegister");
    settingsBtn!.textContent = t("account.settings");
    renderSettingsMenu(menu!, {
      onClose: closeMenu,
      onSettingsChange: opts.onSettingsChange,
      openAuth: (mode) => openAuthModal(mode, refresh),
      refreshAccount: refresh,
    });
    opts.onAccountChange?.();
  };

  loginBtn.onclick = (e) => {
    e.stopPropagation();
    closeMenu();
    const user = loadAccount();
    if (!user) {
      openAuthModal("login", refresh);
      return;
    }
    openAccountQuick(user, refresh);
  };

  // Click/tap toggles for touch; desktop primarily uses CSS :hover
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    if (menu!.classList.contains("is-open")) closeMenu();
    else openMenu();
  };

  document.addEventListener("click", (e) => {
    if (!settingsWrap!.contains(e.target as Node)) closeMenu();
  });

  refresh();

  registerSessionUi({
    refresh,
    openLogin: () => openAuthModal("login", refresh),
  });

  // Fix sessions that stored phone/id as the display label
  void (async () => {
    const user = loadAccount();
    if (!user || isUsableDisplayName(user.name)) return;
    const base = loadSettings().apijsonBaseUrl.replace(/\/+$/, "");
    const account = user.login || user.name;
    let profile: UserRow | null = null;
    if (user.userId != null) profile = await fetchUserById(base, user.userId);
    if (!profile && looksLikePhoneOrId(account)) {
      profile = await fetchUserByPhone(base, account);
    }
    const resolved = pickUserName(profile);
    if (!resolved || !isUsableDisplayName(resolved)) return;
    saveAccount({
      ...user,
      name: resolved,
      login: user.login || account,
      userId: profile?.id ?? user.userId,
      email: profile?.email ? String(profile.email) : user.email,
    });
    refresh();
  })();

  return { refresh };
}

function openAccountQuick(user: AccountUser, onDone: () => void) {
  document.getElementById("account-quick")?.remove();
  const pop = document.createElement("div");
  pop.id = "account-quick";
  pop.className = "account-quick";

  const title = document.createElement("div");
  title.className = "account-quick-title";
  title.textContent = user.name;

  const role = document.createElement("div");
  role.className = "account-quick-meta";
  role.textContent = isAdminUser(user)
    ? t("account.vendorAdmin")
    : t("account.signedIn");

  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "danger";
  logout.textContent = t("account.logout");
  logout.onclick = () => {
    void clearApijsonBffSession();
    saveAccount(null);
    pop.remove();
    onDone();
  };

  const close = () => pop.remove();
  pop.append(title, role, logout);
  document.body.appendChild(pop);

  // Position under login button
  const btn = document.getElementById("account-login-btn");
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }

  const onDoc = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== btn) {
      close();
      document.removeEventListener("click", onDoc);
    }
  };
  setTimeout(() => document.addEventListener("click", onDoc), 0);
}

function renderSettingsMenu(
  menu: HTMLElement,
  ctx: {
    onClose: () => void;
    onSettingsChange?: (s: AiSettings) => void;
    openAuth: (mode: "login" | "register") => void;
    refreshAccount: () => void;
  },
) {
  menu.innerHTML = "";
  const user = loadAccount();
  let settings = loadSettings();

  const head = document.createElement("div");
  head.className = "account-menu-head";
  head.textContent = t("account.settings");
  menu.appendChild(head);

  const persist = (next: AiSettings) => {
    settings = next;
    saveSettings(next);
    ctx.onSettingsChange?.(next);
    renderSettingsMenu(menu, ctx);
  };

  const addValueRow = (
    label: string,
    valueText: string,
    onEdit: () => void,
    opts?: { muted?: boolean },
  ) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "account-menu-item";
    const lab = document.createElement("span");
    lab.className = "account-menu-item-label";
    lab.textContent = label;
    const val = document.createElement("span");
    val.className =
      "account-menu-item-value" + (opts?.muted ? " is-muted" : "");
    val.textContent = valueText;
    row.append(lab, val);
    row.onclick = (e) => {
      e.stopPropagation();
      onEdit();
    };
    menu.appendChild(row);
  };

  const promptEdit = (
    title: string,
    current: string,
    apply: (v: string) => void,
    opts?: { password?: boolean; placeholder?: string },
  ) => {
    const next = window.prompt(
      title,
      opts?.password ? "" : current,
    );
    if (next === null) return;
    apply(next.trim());
  };

  addValueRow(
    t("account.apijsonBase"),
    truncate(settings.apijsonBaseUrl),
    () =>
      promptEdit(
        t("account.apijsonBasePrompt"),
        settings.apijsonBaseUrl,
        (v) =>
          persist({
            ...settings,
            apijsonBaseUrl: v || DEFAULT_SETTINGS.apijsonBaseUrl,
          }),
      ),
  );

  addValueRow(t("account.aiModel"), truncate(settings.model, 36), () =>
    promptEdit(t("account.aiModel"), settings.model, (v) =>
      persist({ ...settings, model: v || DEFAULT_SETTINGS.model }),
    ),
  );

  addValueRow(t("account.aiBaseUrl"), truncate(settings.baseUrl), () =>
    promptEdit(t("account.aiBaseUrl"), settings.baseUrl, (v) =>
      persist({
        ...settings,
        baseUrl: v || DEFAULT_SETTINGS.baseUrl,
      }),
    ),
  );

  addValueRow(
    t("account.aiApiKey"),
    maskKey(settings.apiKey),
    () =>
      promptEdit(
        t("account.aiApiKeyPrompt"),
        settings.apiKey,
        (v) => persist({ ...settings, apiKey: v }),
        { password: true, placeholder: "sk-…" },
      ),
    { muted: !settings.apiKey.trim() },
  );

  // UI language (reloads so dynamic panes rebuild)
  const uiLangRow = document.createElement("div");
  uiLangRow.className = "account-menu-item account-menu-item-static";
  const uiLangLab = document.createElement("span");
  uiLangLab.className = "account-menu-item-label";
  uiLangLab.textContent = t("account.uiLanguage");
  const uiLangSel = document.createElement("select");
  uiLangSel.className = "account-menu-inline-select";
  for (const [v, label] of [
    ["en", t("account.langEn")],
    ["zh-CN", t("account.langZh")],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (getUiLocale() === v) o.selected = true;
    uiLangSel.appendChild(o);
  }
  uiLangSel.onchange = () => {
    const next = uiLangSel.value as UiLocale;
    if (next === getUiLocale()) return;
    setUiLocale(next);
  };
  uiLangRow.append(uiLangLab, uiLangSel);
  menu.appendChild(uiLangRow);

  // AI reply language (sent to LLM — independent of UI locale)
  const langRow = document.createElement("div");
  langRow.className = "account-menu-item account-menu-item-static";
  const langLab = document.createElement("span");
  langLab.className = "account-menu-item-label";
  langLab.textContent = t("account.aiLanguage");
  const langSel = document.createElement("select");
  langSel.className = "account-menu-inline-select";
  for (const [v, label] of [
    ["en", t("account.langEn")],
    ["zh-CN", t("account.langZh")],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (settings.language === v) o.selected = true;
    langSel.appendChild(o);
  }
  langSel.onchange = () => {
    persist({ ...settings, language: langSel.value || "en" });
  };
  langRow.append(langLab, langSel);
  menu.appendChild(langRow);

  const foot = document.createElement("div");
  foot.className = "account-menu-actions";
  if (user) {
    const logout = document.createElement("button");
    logout.type = "button";
    logout.textContent = t("account.logout");
    logout.onclick = () => {
      void clearApijsonBffSession();
      saveAccount(null);
      ctx.refreshAccount();
      ctx.onClose();
    };
    foot.appendChild(logout);
  } else {
    const login = document.createElement("button");
    login.type = "button";
    login.className = "primary";
    login.textContent = t("account.login");
    login.onclick = () => {
      ctx.onClose();
      ctx.openAuth("login");
    };
    const reg = document.createElement("button");
    reg.type = "button";
    reg.textContent = t("account.register");
    reg.onclick = () => {
      ctx.onClose();
      ctx.openAuth("register");
    };
    foot.append(login, reg);
  }
  menu.appendChild(foot);
}

function openAuthModal(
  mode: "login" | "register",
  onDone: () => void,
) {
  document.getElementById("auth-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "auth-modal";
  modal.className = "auth-modal";

  const panel = document.createElement("div");
  panel.className = "auth-panel";

  const title = document.createElement("h3");
  title.textContent =
    mode === "login" ? t("account.login") : t("account.register");

  const nameField = labeledField(
    t("account.account"),
    (() => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = t("account.usernameOrPhone");
      inp.autocomplete = "username";
      try {
        const remembered = localStorage.getItem(REMEMBER_KEY);
        if (remembered && mode === "login") inp.value = remembered;
      } catch {
        /* ignore */
      }
      return inp;
    })(),
  );

  const passField = labeledField(
    t("account.password"),
    (() => {
      const inp = document.createElement("input");
      inp.type = "password";
      inp.placeholder = t("account.password");
      inp.autocomplete =
        mode === "login" ? "current-password" : "new-password";
      return inp;
    })(),
  );

  const emailField = labeledField(
    t("account.email"),
    (() => {
      const inp = document.createElement("input");
      inp.type = "email";
      inp.placeholder = t("account.optional");
      inp.autocomplete = "email";
      return inp;
    })(),
  );
  if (mode === "login") emailField.classList.add("hidden");

  const rememberWrap = document.createElement("label");
  rememberWrap.className = "auth-remember";
  const rememberCb = document.createElement("input");
  rememberCb.type = "checkbox";
  rememberCb.checked = true;
  rememberWrap.append(
    rememberCb,
    document.createTextNode(t("account.rememberLogin")),
  );
  if (mode !== "login") rememberWrap.classList.add("hidden");

  const err = document.createElement("div");
  err.className = "auth-error";

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary auth-submit";
  submit.textContent =
    mode === "login" ? t("account.login") : t("account.register");

  const switchBtn = document.createElement("button");
  switchBtn.type = "button";
  switchBtn.className = "auth-switch";
  switchBtn.textContent =
    mode === "login" ? t("account.needAccount") : t("account.haveAccount");
  switchBtn.onclick = () => {
    modal.remove();
    openAuthModal(mode === "login" ? "register" : "login", onDone);
  };

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "auth-cancel";
  cancel.textContent = t("common.cancel");
  cancel.onclick = () => modal.remove();

  const nameInp = nameField.querySelector("input") as HTMLInputElement;
  const passInp = passField.querySelector("input") as HTMLInputElement;
  const emailInp = emailField.querySelector("input") as HTMLInputElement;

  const doSubmit = async () => {
    const account = nameInp.value.trim();
    const password = passInp.value;
    if (!account || !password) {
      err.textContent = t("account.accountPasswordRequired");
      return;
    }
    submit.disabled = true;
    err.textContent = "";
    try {
      const settings = loadSettings();
      const base = settings.apijsonBaseUrl.replace(/\/+$/, "");
      let displayName = account;
      let email = emailInp.value.trim() || undefined;
      let userId: string | number | undefined;
      if (mode === "login") {
        const loginData = await apijsonLogin(base, account, password);
        if (!loginData) {
          err.textContent = t("account.loginFailed");
          return;
        }
        const profile = await resolveDisplayProfile(base, account, loginData);
        displayName = profile.name;
        userId = profile.userId;
        if (!email && profile.email) email = profile.email;
        if (rememberCb.checked) {
          localStorage.setItem(REMEMBER_KEY, account);
        } else {
          localStorage.removeItem(REMEMBER_KEY);
        }
      } else {
        try {
          const res = await fetch(
            `${base}/post`,
            withApijsonAuth({
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                stripApiJsonRole({
                  User: {
                    name: account,
                    password,
                    ...(email ? { email } : {}),
                  },
                  tag: "User",
                }),
              ),
            }),
          );
          const data = (await res.json().catch(() => null)) as {
            User?: { name?: string; id?: number | string };
          } | null;
          const serverName = String(data?.User?.name ?? "").trim();
          displayName = isUsableDisplayName(serverName) ? serverName : account;
          userId = data?.User?.id;
        } catch {
          displayName = account;
        }
      }
      const lower = displayName.toLowerCase();
      const accountKey = account.toLowerCase();
      saveAccount({
        name: displayName,
        login: account,
        userId,
        password,
        email,
        remember: rememberCb.checked,
        role:
          lower === "admin" ||
          lower === "vendor" ||
          accountKey === "admin" ||
          accountKey === "vendor"
            ? "admin"
            : "user",
      });
      modal.remove();
      onDone();
    } finally {
      submit.disabled = false;
    }
  };

  submit.onclick = () => void doSubmit();
  passInp.onkeydown = (e) => {
    if (e.key === "Enter") void doSubmit();
  };
  nameInp.onkeydown = (e) => {
    if (e.key === "Enter") passInp.focus();
  };

  const actions = document.createElement("div");
  actions.className = "auth-actions";
  actions.append(cancel);

  panel.append(
    title,
    nameField,
    passField,
    emailField,
    rememberWrap,
    err,
    submit,
    actions,
    switchBtn,
  );
  modal.appendChild(panel);
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
  document.body.appendChild(modal);
  nameInp.focus();
  if (nameInp.value) passInp.focus();
}

function labeledField(label: string, input: HTMLInputElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "auth-field";
  const lab = document.createElement("span");
  lab.textContent = label;
  wrap.append(lab, input);
  return wrap;
}
