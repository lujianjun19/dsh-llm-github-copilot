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

