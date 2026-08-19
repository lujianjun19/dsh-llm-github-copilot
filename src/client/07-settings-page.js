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
      const models = Array.isArray(status?.models) ? status.models : [];
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
                      jsx("p", { style: { ...css.body, fontWeight: 500 }, children: text("models", { count: status.modelCount ?? models.length }) }),
                      models.length === 0
                        ? jsx("p", { style: css.hint, children: text("noModels") })
                        : jsx("ul", {
                            style: css.models,
                            children: models.map((model) => jsx("li", { style: css.model, children: model.name === model.id ? model.id : `${model.name} (${model.id})` }, model.id))
                          })
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

