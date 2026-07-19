/**
 * APIAuto-style account + AI settings (top-right Login / Settings).
 * Credentials & API keys stay in localStorage; LLM overrides go with chat/analyze.
 */

export type AccountUser = {
  name: string;
  password?: string;
  email?: string;
  /** Vendor admin only — unlocks Admin approvals tab */
  role?: "user" | "admin";
  remember?: boolean;
};

/** Demo gate: Admin tab for vendor admins (name admin/vendor, or role=admin). */
export function isAdminUser(user: AccountUser | null = loadAccount()): boolean {
  if (!user?.name) return false;
  if (user.role === "admin") return true;
  const n = user.name.trim().toLowerCase();
  return n === "admin" || n === "vendor";
}

export type AiSettings = {
  model: string;
  baseUrl: string;
  apiKey: string;
  language: string;
  /** Hosted / APIJSON server URL */
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
  apijsonBaseUrl: "http://localhost:8080",
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
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AiSettings>) };
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

export function mountAccountUi(opts: {
  headerEl: HTMLElement;
  metaEl: HTMLElement;
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
    opts.headerEl.insertBefore(wrap, opts.metaEl);
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
      openAuth: (mode) => openAuthModal(mode, refresh),
      refreshAccount: refresh,
    });
    opts.onAccountChange?.();
  };

  loginBtn.onclick = (e) => {
    e.stopPropagation();
    menu!.classList.add("hidden");
    const user = loadAccount();
    if (!user) {
      openAuthModal("login", refresh);
      return;
    }
    openAccountQuick(user, refresh);
  };

  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    menu!.classList.toggle("hidden");
    if (!menu!.classList.contains("hidden")) {
      renderSettingsMenu(menu!, {
        onClose: () => menu!.classList.add("hidden"),
        onSettingsChange: opts.onSettingsChange,
        openAuth: (mode) => openAuthModal(mode, refresh),
        refreshAccount: refresh,
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
  head.textContent = "Settings";
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
    "Hosted server URL",
    truncate(settings.apijsonBaseUrl),
    () =>
      promptEdit(
        "Hosted server URL (APIJSON)",
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
      promptEdit(
        "AI API Key (leave empty to clear)",
        settings.apiKey,
        (v) => persist({ ...settings, apiKey: v }),
        { password: true, placeholder: "sk-…" },
      ),
    { muted: !settings.apiKey.trim() },
  );

  // Language as inline select row (APIAuto shows current value)
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
      saveAccount(null);
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
    const name = nameInp.value.trim();
    const password = passInp.value;
    if (!name || !password) {
      err.textContent = "Account and password required";
      return;
    }
    submit.disabled = true;
    err.textContent = "";
    try {
      const settings = loadSettings();
      const base = settings.apijsonBaseUrl.replace(/\/+$/, "");
      if (mode === "login") {
        try {
          await fetch(`${base}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              User: { name, password },
            }),
          });
        } catch {
          /* local-only ok */
        }
        if (rememberCb.checked) {
          localStorage.setItem(REMEMBER_KEY, name);
        } else {
          localStorage.removeItem(REMEMBER_KEY);
        }
      } else {
        try {
          await fetch(`${base}/post`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              User: {
                name,
                password,
                ...(emailInp.value.trim()
                  ? { email: emailInp.value.trim() }
                  : {}),
              },
              tag: "User",
            }),
          });
        } catch {
          /* local-only ok */
        }
      }
      const lower = name.toLowerCase();
      saveAccount({
        name,
        password,
        email: emailInp.value.trim() || undefined,
        remember: rememberCb.checked,
        role: lower === "admin" || lower === "vendor" ? "admin" : "user",
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
