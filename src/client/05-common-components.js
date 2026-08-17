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

