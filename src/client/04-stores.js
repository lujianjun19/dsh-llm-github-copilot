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

