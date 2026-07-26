/**
 * Login / Settings (copied from chat-demo account UI).
 * Creds sync into aj-http localStorage for APIJSON CRUD + approve decide.
 */

import {
  clearCreds,
  getApijsonBase,
  loadSavedCreds,
  resetApijsonSession,
  saveCreds,
} from "./aj-http.js";

export type AccountUser = {
  name: string;
  login?: string;
  userId?: string | number;
  password?: string;
  email?: string;
  role?: "user" | "admin";
  remember?: boolean;
};

export type AdminSettings = {
  model: string;
  baseUrl: string;
  apiKey: string;
  language: string;
  apijsonBaseUrl: string;
};

const ACCOUNT_KEY = "a2api.admin.account";
const SETTINGS_KEY = "a2api.admin.settings";
const REMEMBER_KEY = "a2api.admin.remember";

const DEFAULT_SETTINGS: AdminSettings = {
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  language: "en",
  apijsonBaseUrl: "http://localhost:8080",
};

function looksLikePhoneOrId(s: string): boolean {
  return /^\d{5,}$/.test(s.trim());
}

function isUsableDisplayName(s: string): boolean {
  const t = s.trim();
  return Boolean(t) && !looksLikePhoneOrId(t);
}

function withLoginDefaults(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const prev =
    body.defaults &&
    typeof body.defaults === "object" &&
    !Array.isArray(body.defaults)
      ? (body.defaults as Record<string, unknown>)
      : {};
  return {
    ...body,
    defaults: { ...prev, "@role": "LOGIN" },
  };
}

function stripApiJsonRole(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!("@role" in body)) return { ...body };
  const next = { ...body };
  delete next["@role"];
  return next;
}

type UserRow = {
  name?: string;
  id?: number | string;
  phone?: number | string;
  email?: string;
};

function pickUserName(u: UserRow | null | undefined): string {
  if (!u) return "";
  return String(u.name ?? "").trim();
}

function pickUserId(data: Record<string, unknown> | null): string | number | null {
  if (!data) return null;
  const u = (data.User || data.user) as UserRow | undefined;
  if (u?.id != null && u.id !== "") return u.id;
  const top =
    data.userId ?? data.userid ?? data.id ?? data.visitorId ?? data.visitorid;
  if (top != null && top !== "") return top as string | number;
  return null;
}

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
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          withLoginDefaults(body as Record<string, unknown>),
        ),
      });
      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!data) continue;
      const code = data.code;
      if (code === 200 || code === 0 || code == null) return data;
      if (data.User || data.user || data.userId != null) return data;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchUserById(
  base: string,
  id: string | number,
): Promise<UserRow | null> {
  try {
    const res = await fetch(`${base}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        withLoginDefaults({
          User: { id, "@column": "id,name,phone,email" },
        }),
      ),
    });
    const data = (await res.json().catch(() => null)) as {
      User?: UserRow;
      code?: number;
    } | null;
    if (data?.User && (data.code === 200 || data.code == null)) {
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
  const phoneVal: string | number = /^\d+$/.test(phone) ? Number(phone) : phone;
  try {
    const res = await fetch(`${base}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        withLoginDefaults({
          User: { phone: phoneVal, "@column": "id,name,phone,email" },
        }),
      ),
    });
    const data = (await res.json().catch(() => null)) as {
      User?: UserRow;
      code?: number;
    } | null;
    if (data?.User && (data.code === 200 || data.code == null)) {
      return data.User;
    }
  } catch {
    /* ignore */
  }
  if (/^\d{11}$/.test(phone)) {
    const shortId = Number(phone.slice(-5));
    if (shortId > 0) {
      const byId = await fetchUserById(base, shortId);
      if (byId) return byId;
    }
  }
  return null;
}

async function resolveDisplayProfile(
  base: string,
  account: string,
  loginData: Record<string, unknown> | null,
): Promise<{ name: string; userId?: string | number; email?: string }> {
  let userId = pickUserId(loginData);
  let fromLogin = pickUserName(
    (loginData?.User || loginData?.user) as UserRow | undefined,
  );
  if (isUsableDisplayName(fromLogin)) {
    return {
      name: fromLogin,
      userId: userId ?? undefined,
      email:
        String(
          ((loginData?.User || loginData?.user) as UserRow | undefined)?.email ??
            "",
        ).trim() || undefined,
    };
  }

  let profile: UserRow | null = null;
  if (userId != null) profile = await fetchUserById(base, userId);
  if (!profile && looksLikePhoneOrId(account)) {
    profile = await fetchUserByPhone(base, account);
  }
  const resolved = pickUserName(profile);
  if (isUsableDisplayName(resolved)) {
    return {
      name: resolved,
      userId: profile?.id ?? userId ?? undefined,
      email: profile?.email ? String(profile.email) : undefined,
    };
  }
  if (isUsableDisplayName(account)) {
    return { name: account, userId: userId ?? undefined };
  }
  return {
    name: resolved || account,
    userId: profile?.id ?? userId ?? undefined,
    email: profile?.email ? String(profile.email) : undefined,
  };
}

export function isAdminUser(user: AccountUser | null = loadAccount()): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const keys = [user.name, user.login].filter(Boolean).map((s) =>
    String(s).trim().toLowerCase(),
  );
  return keys.some((n) => n === "admin" || n === "vendor");
}

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
  if (!user) {
    localStorage.removeItem(ACCOUNT_KEY);
    clearCreds();
    return;
  }
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(user));
  if (user.login && user.password) {
    saveCreds(user.login, user.password);
  }
}

export function logoutAccount(): void {
  saveAccount(null);
  resetApijsonSession();
}

export function loadSettings(): AdminSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(raw) as Partial<AdminSettings>),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AdminSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function maskKey(key: string): string {
  const t = key.trim();
  if (!t) return "Click to set";
  if (t.length <= 8) return "••••••••";
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}

function truncate(s: string, n = 42): string {
  const t = s.trim();
  if (!t) return "—";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** After silent APIJSON login, hydrate display account from saved creds. */
export async function hydrateAccountFromSession(): Promise<void> {
  if (loadAccount()) return;
  const creds = loadSavedCreds();
  if (!creds.login || !creds.password) return;
  const base = (loadSettings().apijsonBaseUrl || getApijsonBase()).replace(
    /\/+$/,
    "",
  );
  const loginData = await apijsonLogin(base, creds.login, creds.password);
  if (!loginData) return;
  const profile = await resolveDisplayProfile(base, creds.login, loginData);
  saveAccount({
    name: profile.name,
    login: creds.login,
    password: creds.password,
    userId: profile.userId,
    email: profile.email,
    remember: true,
    role: "admin",
  });
}

export function mountAccountUi(opts: {
  headerEl: HTMLElement;
  onSettingsChange?: (s: AdminSettings) => void;
  onAccountChange?: () => void;
}): { refresh: () => void } {
  let wrap =
    (document.getElementById("account-root") as HTMLElement | null) ||
    (opts.headerEl.querySelector(".account-wrap") as HTMLElement | null);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "account-wrap";
    wrap.id = "account-root";
    opts.headerEl.appendChild(wrap);
  }

  let loginBtn = document.getElementById(
    "account-login-btn",
  ) as HTMLButtonElement | null;
  if (!loginBtn) {
    loginBtn = document.createElement("button");
    loginBtn.type = "button";
    loginBtn.className = "account-link";
    loginBtn.id = "account-login-btn";
    loginBtn.textContent = "Login";
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
    settingsBtn.textContent = "Settings";
    wrap.appendChild(settingsBtn);
  }

  let menu = document.getElementById("account-menu") as HTMLElement | null;
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "account-menu hidden";
    menu.id = "account-menu";
    wrap.appendChild(menu);
  } else if (!wrap.contains(menu)) {
    wrap.appendChild(menu);
  }

  const refresh = () => {
    const user = loadAccount();
    loginBtn!.textContent = user?.name || "Login";
    loginBtn!.title = user?.name ? "Account" : "Login / Register";
    settingsBtn!.textContent = "Settings";
    renderSettingsMenu(menu!, {
      onClose: () => menu!.classList.add("hidden"),
      onSettingsChange: opts.onSettingsChange,
      openAuth: (mode) => openAuthModal(mode, afterAuth),
      refreshAccount: afterAuth,
    });
  };

  /** Login / logout / register — notify host once (avoid refresh loops). */
  const afterAuth = () => {
    refresh();
    opts.onAccountChange?.();
  };

  loginBtn.onclick = (e) => {
    e.stopPropagation();
    menu!.classList.add("hidden");
    const user = loadAccount();
    if (!user) {
      openAuthModal("login", afterAuth);
      return;
    }
    openAccountQuick(user, afterAuth);
  };

  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    menu!.classList.toggle("hidden");
    if (!menu!.classList.contains("hidden")) {
      renderSettingsMenu(menu!, {
        onClose: () => menu!.classList.add("hidden"),
        onSettingsChange: opts.onSettingsChange,
        openAuth: (mode) => openAuthModal(mode, afterAuth),
        refreshAccount: afterAuth,
      });
    }
  };

  document.addEventListener("click", (e) => {
    if (!wrap!.contains(e.target as Node)) menu!.classList.add("hidden");
  });

  refresh();
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
  role.textContent = isAdminUser(user) ? "Vendor admin" : "Signed in";

  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "danger";
  logout.textContent = "Log out";
  logout.onclick = () => {
    logoutAccount();
    pop.remove();
    onDone();
  };

  pop.append(title, role, logout);
  document.body.appendChild(pop);

  const btn = document.getElementById("account-login-btn");
  if (btn) {
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }

  const onDoc = (ev: MouseEvent) => {
    if (!pop.contains(ev.target as Node) && ev.target !== btn) {
      pop.remove();
      document.removeEventListener("click", onDoc);
    }
  };
  setTimeout(() => document.addEventListener("click", onDoc), 0);
}

function renderSettingsMenu(
  menu: HTMLElement,
  ctx: {
    onClose: () => void;
    onSettingsChange?: (s: AdminSettings) => void;
    openAuth: (mode: "login" | "register") => void;
    refreshAccount: () => void;
  },
) {
  menu.innerHTML = "";
  const user = loadAccount();
  let settings = loadSettings();

  const head = document.createElement("div");
  head.className = "account-menu-head";
  head.textContent = "Settings";
  menu.appendChild(head);

  const persist = (next: AdminSettings) => {
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

  const promptEdit = (title: string, current: string, apply: (v: string) => void) => {
    const next = window.prompt(title, current);
    if (next === null) return;
    apply(next.trim());
  };

  addValueRow(
    "APIJSON / Hosted server URL",
    truncate(settings.apijsonBaseUrl),
    () =>
      promptEdit(
        "APIJSON / Hosted server URL",
        settings.apijsonBaseUrl,
        (v) =>
          persist({
            ...settings,
            apijsonBaseUrl: v || DEFAULT_SETTINGS.apijsonBaseUrl,
          }),
      ),
  );

  addValueRow("AI Model", truncate(settings.model, 36), () =>
    promptEdit("AI Model", settings.model, (v) =>
      persist({ ...settings, model: v || DEFAULT_SETTINGS.model }),
    ),
  );

  addValueRow("AI Base URL", truncate(settings.baseUrl), () =>
    promptEdit("AI Base URL", settings.baseUrl, (v) =>
      persist({
        ...settings,
        baseUrl: v || DEFAULT_SETTINGS.baseUrl,
      }),
    ),
  );

  addValueRow(
    "AI API Key",
    maskKey(settings.apiKey),
    () =>
      promptEdit("AI API Key (leave empty to clear)", "", (v) =>
        persist({ ...settings, apiKey: v }),
      ),
    { muted: !settings.apiKey.trim() },
  );

  const langRow = document.createElement("div");
  langRow.className = "account-menu-item account-menu-item-static";
  const langLab = document.createElement("span");
  langLab.className = "account-menu-item-label";
  langLab.textContent = "AI Language";
  const langSel = document.createElement("select");
  langSel.className = "account-menu-inline-select";
  for (const [v, t] of [
    ["en", "en"],
    ["zh-CN", "zh-CN"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
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
    logout.textContent = "Log out";
    logout.onclick = () => {
      logoutAccount();
      ctx.refreshAccount();
      ctx.onClose();
    };
    foot.appendChild(logout);
  } else {
    const login = document.createElement("button");
    login.type = "button";
    login.className = "primary";
    login.textContent = "Login";
    login.onclick = () => {
      ctx.onClose();
      ctx.openAuth("login");
    };
    const reg = document.createElement("button");
    reg.type = "button";
    reg.textContent = "Register";
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
  title.textContent = mode === "login" ? "Login" : "Register";

  const nameField = labeledField(
    "Account",
    (() => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "Username or phone";
      inp.autocomplete = "username";
      try {
        const remembered = localStorage.getItem(REMEMBER_KEY);
        if (remembered && mode === "login") inp.value = remembered;
        else if (mode === "login") {
          inp.value = loadSavedCreds().login || "13000082001";
        }
      } catch {
        /* ignore */
      }
      return inp;
    })(),
  );

  const passField = labeledField(
    "Password",
    (() => {
      const inp = document.createElement("input");
      inp.type = "password";
      inp.placeholder = "Password";
      inp.autocomplete =
        mode === "login" ? "current-password" : "new-password";
      return inp;
    })(),
  );

  const emailField = labeledField(
    "Email",
    (() => {
      const inp = document.createElement("input");
      inp.type = "email";
      inp.placeholder = "Optional";
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
  rememberWrap.append(rememberCb, document.createTextNode(" Remember login"));
  if (mode !== "login") rememberWrap.classList.add("hidden");

  const err = document.createElement("div");
  err.className = "auth-error";

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary auth-submit";
  submit.textContent = mode === "login" ? "Login" : "Register";

  const switchBtn = document.createElement("button");
  switchBtn.type = "button";
  switchBtn.className = "auth-switch";
  switchBtn.textContent =
    mode === "login" ? "Need an account? Register" : "Have an account? Login";
  switchBtn.onclick = () => {
    modal.remove();
    openAuthModal(mode === "login" ? "register" : "login", onDone);
  };

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "auth-cancel";
  cancel.textContent = "Cancel";
  cancel.onclick = () => modal.remove();

  const nameInp = nameField.querySelector("input") as HTMLInputElement;
  const passInp = passField.querySelector("input") as HTMLInputElement;
  const emailInp = emailField.querySelector("input") as HTMLInputElement;

  const doSubmit = async () => {
    const account = nameInp.value.trim();
    const password = passInp.value;
    if (!account || !password) {
      err.textContent = "Account and password required";
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
          err.textContent = "Login failed — check account / password / APIJSON URL";
          return;
        }
        const profile = await resolveDisplayProfile(base, account, loginData);
        displayName = profile.name;
        userId = profile.userId;
        if (!email && profile.email) email = profile.email;
        if (rememberCb.checked) localStorage.setItem(REMEMBER_KEY, account);
        else localStorage.removeItem(REMEMBER_KEY);
      } else {
        try {
          const res = await fetch(`${base}/post`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
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
          });
          const data = (await res.json().catch(() => null)) as {
            User?: { name?: string; id?: number | string };
            code?: number;
            msg?: string;
          } | null;
          if (data && data.code != null && data.code !== 200 && data.code !== 0) {
            err.textContent = data.msg || "Register failed";
            return;
          }
          const serverName = String(data?.User?.name ?? "").trim();
          displayName = isUsableDisplayName(serverName) ? serverName : account;
          userId = data?.User?.id;
        } catch (e) {
          err.textContent = e instanceof Error ? e.message : "Register failed";
          return;
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
      resetApijsonSession();
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
