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
      codeRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }
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

