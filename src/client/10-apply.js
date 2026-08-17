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
