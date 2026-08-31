window.__ModuleLoader__.load({
  id: "@lujianjun19/dsh-llm-github-copilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const {
      Button,
      Input,
      Modal,
      RiskConfirmation,
      StateDot,
      writeClipboard
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useEffect, useState, useSyncExternalStore } = React;

    const API = "/github-copilot-auth";
    const NS = "github-copilot";
    const PLUGIN_VERSION = "0.4.5";
    const EN = {
      nav: "GitHub Copilot",
      title: "GitHub Copilot",
      intro: "Sign in with GitHub OAuth device flow. The plugin stores the long-lived OAuth credential, refreshes short-lived Copilot tokens, and discovers the models available to your account.",
      signedIn: "Signed in",
      pending: "Waiting for GitHub authorization",
      signedOut: "Signed out",
      signIn: "Sign in to GitHub Copilot",
      requesting: "Requesting…",
      waiting: "Waiting for authorization…",
      signOut: "Sign out",
      processing: "Processing…",
      refresh: "Refresh status",
      pendingIntro: "Open the GitHub device page and enter this code:",
      deviceCode: "Device code",
      copyCode: "Copy code",
      copied: "Copied",
      pendingHint: "This page updates automatically after authorization. You never need to paste a token here.",
      credential: "Credential: {credential}",
      models: "Models available to this account: {count}",
      whereToSelect: "Signing in publishes the credential to the \"{provider}\" provider. Pick a model there under Settings → Models.",
      commandHint: "The /copilot-login, /copilot-status, and /copilot-logout commands remain available on chat surfaces.",
      pluginVersion: "Plugin version:",
      loginDialogTitle: "Sign in to GitHub Copilot",
      loginDialogDescription: "Open the GitHub device page, then enter the device code below.",
      openGitHub: "Open GitHub",
      close: "Close",
      logoutOption: "Sign out of GitHub Copilot",
      logoutOptionDetail: "Remove the GitHub OAuth credential stored on this device",
      logoutConfirmTitle: "Sign out of GitHub Copilot?",
      logoutConfirmDescription: "This removes the OAuth credential stored on this device and immediately removes GitHub Copilot models from the model list. You can sign in again later.",
      logoutAcknowledge: "I understand and want to sign out of GitHub Copilot",
      cancel: "Cancel",
      logoutConfirm: "Sign out",
      sessionUnavailable: "The current session is not ready.",
      logoutFailed: "GitHub Copilot sign-out failed: {message}",
      commandUnavailable: "The Host does not provide /copilot-logout."
    };
    const ZH = {
      nav: "GitHub Copilot",
      title: "GitHub Copilot",
      intro: "通过 GitHub OAuth 设备码登录。插件会保存长期 OAuth 凭据、自动刷新短期 Copilot token，并动态发现当前账号可用的模型。",
      signedIn: "已登录",
      pending: "等待 GitHub 授权",
      signedOut: "未登录",
      signIn: "登录 GitHub Copilot",
      requesting: "正在请求…",
      waiting: "等待授权…",
      signOut: "退出登录",
      processing: "处理中…",
      refresh: "刷新状态",
      pendingIntro: "请打开 GitHub 设备登录页面，然后输入下面的设备码：",
      deviceCode: "设备码",
      copyCode: "复制设备码",
      copied: "已复制",
      pendingHint: "完成授权后本页会自动更新；无需在此粘贴任何 token。",
      credential: "凭据：{credential}",
      models: "本账户可用模型：{count}",
      whereToSelect: "登录后凭据会发布给 \"{provider}\" 提供方。请到设置 → 模型 中选择该提供方下的模型。",
      commandHint: "聊天界面仍可使用 /copilot-login、/copilot-status 和 /copilot-logout。",
      pluginVersion: "插件版本：",
      loginDialogTitle: "登录 GitHub Copilot",
      loginDialogDescription: "打开 GitHub 设备登录页面，然后输入下面的设备码。",
      openGitHub: "打开 GitHub",
      close: "关闭",
      logoutOption: "退出 GitHub Copilot",
      logoutOptionDetail: "删除本机保存的 GitHub OAuth 凭据",
      logoutConfirmTitle: "确认退出 GitHub Copilot？",
      logoutConfirmDescription: "退出后将删除本机保存的 OAuth 凭据，并立即从模型列表中移除 GitHub Copilot 模型。以后仍可重新登录。",
      logoutAcknowledge: "我确认要退出 GitHub Copilot",
      cancel: "取消",
      logoutConfirm: "退出登录",
      sessionUnavailable: "当前会话尚未就绪。",
      logoutFailed: "GitHub Copilot 退出失败：{message}",
      commandUnavailable: "当前 Host 没有提供 /copilot-logout 命令。"
    };

    let localeRuntime;
    const localeSubscribe = (listener) => localeRuntime === void 0 ? () => {} : localeRuntime.subscribe(listener);
    const localeSnapshot = () => localeRuntime?.getSnapshot().revision ?? 0;
    function format(template, params) {
      if (params === void 0) return template;
      return template.replace(/\{([^}]+)\}/g, (match, key) => key in params ? String(params[key]) : match);
    }
    function text(key, params) {
      // Follow the Harness locale exactly; any unknown/unavailable locale falls
      // back to English as this plugin's explicit default.
      const dictionary = localeRuntime?.getSnapshot().active === "zh" ? ZH : EN;
      return format(dictionary[key] ?? EN[key] ?? key, params);
    }
    function useLocaleRevision() {
      useSyncExternalStore(localeSubscribe, localeSnapshot, () => 0);
    }

    const css = {
      section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 760, paddingBottom: 32 },
      title: { margin: 0, fontSize: 22, lineHeight: "30px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      intro: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-secondary)" },
      card: { display: "flex", flexDirection: "column", gap: 16, padding: 18, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      status: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      actions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      field: { display: "flex", flexDirection: "column", gap: 8 },
      label: { fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      link: { color: "var(--dsw-alias-brand-primary)", fontSize: 14, lineHeight: "22px", overflowWrap: "anywhere" },
      hint: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      body: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
      error: { margin: 0, whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-error, var(--dsw-alias-state-danger-label))" },
      models: { margin: 0, paddingLeft: 20, columns: 2, columnGap: 28, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" },
      model: { breakInside: "avoid" },
      modalBody: { display: "flex", flexDirection: "column", gap: 14 },
      codeRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      versionLink: { color: "var(--dsw-alias-brand-primary)" }
    };

    async function request(path, method = "GET") {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`GitHub Copilot request failed (HTTP ${response.status})`);
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `GitHub Copilot request failed (HTTP ${response.status})`);
      }
      return payload.value;
    }

    function createStore(initial) {
      let snapshot = initial;
      const listeners = /* @__PURE__ */ new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set: (next) => {
          snapshot = next;
          for (const listener of listeners) listener();
        }
      };
    }
    const DEFAULT_OAUTH_REF = "GITHUB_COPILOT_OAUTH_TOKEN";
    const loginDialog = createStore({ open: false, verificationUri: "", userCode: "", credentialRef: DEFAULT_OAUTH_REF });
    const closeLoginDialog = () => {
      loginDialog.set({ open: false, verificationUri: "", userCode: "", credentialRef: DEFAULT_OAUTH_REF });
    };
    const closeLoginDialogWhenAuthenticated = async () => {
      if (!loginDialog.getSnapshot().open) return;
      try {
        const status = await request("/status");
        if (status.authenticated === true) closeLoginDialog();
      } catch {
        // Keep the dialog open. The polling fallback or the next credential
        // event can retry; a transient status failure must not hide the code.
      }
    };

    function StateLabel({ status }) {
      useLocaleRevision();
      const authenticated = status?.authenticated === true;
      const pending = status?.state === "pending";
      const label = authenticated ? text("signedIn") : pending ? text("pending") : text("signedOut");
      const state = authenticated ? "done" : pending ? "ongoing" : "error";
      return jsxs("span", { style: css.status, children: [jsx(StateDot, { state }), label] });
    }

    function DeviceCodeField({ value, copied, onCopy }) {
      useLocaleRevision();
      return jsxs("div", {
        style: css.field,
        children: [
          jsx("span", { style: css.label, children: text("deviceCode") }),
          jsxs("div", {
            style: css.codeRow,
            children: [
              jsx(Input, {
                readOnly: true,
                value,
                "aria-label": text("deviceCode"),
                onFocus: (event) => { event.currentTarget.select(); },
                style: { width: "180px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "2px", fontWeight: 600 }
              }),
              jsx(Button, { variant: "outline", size: "sm", onClick: onCopy, children: copied ? text("copied") : text("copyCode") })
            ]
          })
        ]
      });
    }

    function LoginDialog() {
      useLocaleRevision();
      const state = useSyncExternalStore(loginDialog.subscribe, loginDialog.getSnapshot, loginDialog.getSnapshot);
      const [copied, setCopied] = useState(false);
      useEffect(() => { if (state.open) setCopied(false); }, [state.open, state.userCode]);
      useEffect(() => {
        if (!state.open) return;
        // credentials/updated normally closes the dialog immediately. Polling
        // is a bounded fallback for a reconnect or a missed forwarded event.
        const timer = setInterval(() => { void closeLoginDialogWhenAuthenticated(); }, 2e3);
        return () => { clearInterval(timer); };
      }, [state.open, state.userCode]);
      const copy = async () => { if (await writeClipboard(state.userCode)) setCopied(true); };
      return jsx(Modal, {
        open: state.open,
        onClose: closeLoginDialog,
        title: text("loginDialogTitle"),
        closeLabel: text("close"),
        description: text("loginDialogDescription"),
        footer: jsxs(React.Fragment, {
          children: [
            jsx(Button, { variant: "outline", onClick: closeLoginDialog, children: text("close") }),
            jsx(Button, {
              variant: "primary",
              onClick: () => { globalThis.open(state.verificationUri, "_blank", "noopener,noreferrer"); },
              children: text("openGitHub")
            })
          ]
        }),
        children: jsxs("div", {
          style: css.modalBody,
          children: [
            jsx("a", { href: state.verificationUri, target: "_blank", rel: "noreferrer", style: css.link, children: state.verificationUri }),
            jsx(DeviceCodeField, { value: state.userCode, copied, onCopy: () => { void copy(); } })
          ]
        })
      });
    }

    function GitHubCopilotSettings() {
      useLocaleRevision();
      const [status, setStatus] = useState();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState();
      const [copied, setCopied] = useState(false);
      const [confirmLogout, setConfirmLogout] = useState(false);
      const [acknowledged, setAcknowledged] = useState(false);

      const refresh = async () => {
        try {
          const next = await request("/status");
          setStatus(next);
          setError(void 0);
          return next;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return void 0;
        }
      };
      useEffect(() => {
        let alive = true;
        request("/status").then(
          (value) => { if (alive) setStatus(value); },
          (cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
        );
        return () => { alive = false; };
      }, []);
      useEffect(() => {
        if (status?.state !== "pending") return;
        const timer = setInterval(() => { void refresh(); }, 2e3);
        return () => { clearInterval(timer); };
      }, [status?.state]);

      const login = async () => {
        setBusy(true);
        setError(void 0);
        try {
          const next = await request("/login", "POST");
          setStatus(next);
          if (next.authenticated) await refresh();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };
      const logout = async () => {
        setBusy(true);
        setError(void 0);
        try {
          setStatus(await request("/logout", "POST"));
          setConfirmLogout(false);
          setAcknowledged(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };
      const copy = async () => {
        if (await writeClipboard(status?.userCode ?? "")) setCopied(true);
      };
      const pending = status?.state === "pending";
      const authenticated = status?.authenticated === true;
      return jsxs("section", {
        style: css.section,
        children: [
          jsx("h2", { style: css.title, children: text("title") }),
          jsx("p", { style: css.intro, children: text("intro") }),
          jsxs("div", {
            style: css.card,
            children: [
              jsxs("div", {
                style: css.row,
                children: [
                  jsx(StateLabel, { status }),
                  jsxs("div", {
                    style: css.actions,
                    children: [
                      authenticated
                        ? jsx(Button, {
                            variant: "outline",
                            disabled: busy,
                            onClick: () => { setAcknowledged(false); setConfirmLogout(true); },
                            children: busy ? text("processing") : text("signOut")
                          })
                        : jsx(Button, {
                            variant: "primary",
                            disabled: busy || pending,
                            onClick: () => { void login(); },
                            children: busy ? text("requesting") : pending ? text("waiting") : text("signIn")
                          }),
                      jsx(Button, { variant: "outline", disabled: busy, onClick: () => { void refresh(); }, children: text("refresh") })
                    ]
                  })
                ]
              }),
              error === void 0 ? null : jsx("p", { role: "alert", style: css.error, children: error }),
              pending
                ? jsxs(React.Fragment, {
                    children: [
                      jsx("p", { style: css.body, children: text("pendingIntro") }),
                      jsx("a", { href: status.verificationUri, target: "_blank", rel: "noreferrer", style: css.link, children: status.verificationUri }),
                      jsx(DeviceCodeField, { value: status.userCode ?? "", copied, onCopy: () => { void copy(); } }),
                      jsx("p", { style: css.hint, children: text("pendingHint") })
                    ]
                  })
                : null,
              !authenticated && !pending && status?.message ? jsx("p", { style: css.error, children: status.message }) : null,
              authenticated
                ? jsxs(React.Fragment, {
                    children: [
                      jsx("p", { style: css.body, children: text("credential", { credential: status.credential ?? "GITHUB_COPILOT_OAUTH_TOKEN" }) }),
                      typeof status.modelCount === "number"
                        ? jsx("p", { style: { ...css.body, fontWeight: 500 }, children: text("models", { count: status.modelCount }) })
                        : null,
                      jsx("p", { style: css.hint, children: text("whereToSelect", { provider: status.provider ?? "github-copilot" }) })
                    ]
                  })
                : null
            ]
          }),
          jsx("p", { style: css.hint, children: text("commandHint") }),
          jsxs("p", {
            style: css.hint,
            children: [
              text("pluginVersion"),
              " ",
              jsx("a", {
                href: `https://github.com/lujianjun19/dsh-llm-github-copilot/releases/tag/v${PLUGIN_VERSION}`,
                target: "_blank",
                rel: "noreferrer",
                style: css.versionLink,
                children: `@lujianjun19/dsh-llm-github-copilot v${PLUGIN_VERSION}`
              })
            ]
          }),
          jsx(RiskConfirmation, {
            open: confirmLogout,
            title: text("logoutConfirmTitle"),
            description: text("logoutConfirmDescription"),
            acknowledgeLabel: text("logoutAcknowledge"),
            cancelLabel: text("cancel"),
            confirmLabel: text("logoutConfirm"),
            acknowledged,
            disabled: busy,
            onAcknowledgedChange: setAcknowledged,
            onCancel: () => { if (!busy) { setConfirmLogout(false); setAcknowledged(false); } },
            onConfirm: () => { void logout(); }
          })
        ]
      });
    }

    function showLoginResult(commandName, result) {
      if (commandName !== "copilot-login" || typeof result?.text !== "string") return;
      const verificationUri = result.text.match(/https:\/\/[^\s]+/)?.[0];
      const userCode = result.text.match(/Enter this code:\s*([A-Z0-9-]+)/i)?.[1];
      if (verificationUri === void 0 || userCode === void 0) return;
      loginDialog.set({ open: true, verificationUri, userCode, credentialRef: DEFAULT_OAUTH_REF });
      // Resolve a customized oauthTokenEnv while the user is authorizing. The
      // response contains only the reference name, never the token value.
      void request("/status").then((status) => {
        const current = loginDialog.getSnapshot();
        if (!current.open || current.userCode !== userCode) return;
        loginDialog.set({ ...current, credentialRef: status.credential ?? DEFAULT_OAUTH_REF });
      }, () => void 0);
    }

    const COPILOT_ICON_PATHS = [
      "M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z",
      "M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"
    ];
    function installSettingsNavIcon() {
      const SVG_NS = "http://www.w3.org/2000/svg";
      const replacements = /* @__PURE__ */ new Map();
      const decorate = () => {
        for (const button of document.querySelectorAll("nav button")) {
          if (button.textContent?.trim() !== "GitHub Copilot") continue;
          const previous = button.querySelector("svg");
          if (previous === null || previous.dataset.githubCopilotIcon === "true") continue;
          const icon = document.createElementNS(SVG_NS, "svg");
          icon.dataset.githubCopilotIcon = "true";
          icon.setAttribute("width", "16");
          icon.setAttribute("height", "16");
          icon.setAttribute("viewBox", "0 0 16 16");
          icon.setAttribute("fill", "currentColor");
          icon.setAttribute("aria-hidden", "true");
          const className = previous.getAttribute("class");
          if (className !== null) icon.setAttribute("class", className);
          for (const d of COPILOT_ICON_PATHS) {
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", d);
            icon.append(path);
          }
          replacements.set(icon, previous);
          previous.replaceWith(icon);
        }
      };
      const observer = new MutationObserver(decorate);
      observer.observe(document.body, { childList: true, subtree: true });
      decorate();
      return () => {
        observer.disconnect();
        for (const [icon, previous] of replacements) {
          if (icon.isConnected) icon.replaceWith(previous);
        }
        replacements.clear();
      };
    }

    const inject = ["slots", "commandUi", "sessions", "locale", "remote"];
    function apply(ctx) {
      localeRuntime = ctx.locale;
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "github-copilot: locale dictionaries");
      ctx.effect(installSettingsNavIcon, "github-copilot: Settings navigation icon");
      ctx.on("command/executed", (_sessionId, commandName, result) => {
        showLoginResult(commandName, result);
      });
      ctx.effect(() => ctx.remote.$on("credentials/updated", (ref) => {
        const current = loginDialog.getSnapshot();
        if (!current.open) return;
        // Matching the reference means the credentials service has already
        // committed the OAuth token, so close immediately without waiting for
        // token exchange or model discovery. A different credential update is
        // filtered through the authoritative status endpoint.
        if (ref === current.credentialRef) closeLoginDialog();
        else void closeLoginDialogWhenAuthenticated();
      }), "github-copilot: close login dialog after credential commit");
      ctx.effect(() => ctx.commandUi.decorate({
        name: "copilot-logout",
        available: () => true,
        ui: {
          kind: "popupSelect",
          options: async () => [{
            id: "logout",
            label: text("logoutOption"),
            detail: text("logoutOptionDetail"),
            confirmation: {
              title: text("logoutConfirmTitle"),
              description: text("logoutConfirmDescription"),
              acknowledgeLabel: text("logoutAcknowledge"),
              cancelLabel: text("cancel"),
              confirmLabel: text("logoutConfirm")
            }
          }],
          onSelect: async (_option, session) => {
            const live = ctx.sessions.binding(session.sessionId)?.session;
            if (live === void 0) throw new Error(text("sessionUnavailable"));
            const result = await live.command("/copilot-logout");
            if (!result.ok) throw new Error(text("logoutFailed", { message: result.error.message }));
            if (!result.value.matched) throw new Error(text("commandUnavailable"));
          }
        }
      }), "github-copilot: confirm /copilot-logout");
      ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "github-copilot-login-dialog",
        order: 50,
        locale: NS
      }, LoginDialog));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "github-copilot",
        order: 11,
        locale: NS,
        label: () => text("nav")
      }, GitHubCopilotSettings));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
