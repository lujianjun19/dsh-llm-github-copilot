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

