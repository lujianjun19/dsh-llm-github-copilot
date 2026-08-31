//#region apply
/**
 * Provision the credential the harness's own Copilot route consumes.
 *
 * This plugin registers no LLM adapter. It owns the GitHub device flow and
 * writes its result as a grant record that `llm-pi-ai` reads for its
 * `github-copilot` provider; that route then performs the Copilot token
 * exchange, refreshes it, derives the account's endpoint, and serves every
 * request. See `docs/adr/0002-narrow-to-credential-provider.md`.
 */
function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error(`${name}: keeping the last good configuration after an invalid settings section`);
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  // ── credential plane ─────────────────────────────────────────────────────
  /**
   * The grant record, when the credentials service is mounted. A composition
   * without one genuinely holds no credential, so reads answer "nothing".
   */
  const readGrant = async () => {
    const credentials = ctx.get("credentials");
    if (credentials === void 0) return void 0;
    return credentials.readRecord(piAiRecordKey());
  };

  /**
   * The long-lived token, from the grant first and the configured reference
   * second. The reference keeps an ambient `export GITHUB_COPILOT_OAUTH_TOKEN=…`
   * working, and is what an installation predating the grant still holds.
   */
  const resolveRawOAuthToken = async () => {
    const fromGrant = grantToken(await readGrant());
    if (fromGrant !== void 0) return fromGrant;
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0 && hit.value.length > 0) return hit.value;
    }
    const ambient = launchEnvironmentOf(ctx).get(ref);
    return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
  };

  /**
   * Publish a token to the consuming route, and to this plugin's own reference
   * so an ambient deployment and a signed-in one look alike.
   *
   * The write is read back and the token compared, because the record's format
   * belongs to another plugin: a shape it stops accepting must fail loudly here
   * rather than leave a credential that silently authenticates nothing.
   */
  const storeRawOAuthToken = async (token) => {
    const credentials = ctx.get("credentials");
    if (credentials === void 0) {
      throw new Error(`${name}: signing in needs the credentials service; mount dsh-credentials-local`);
    }
    await credentials.modifyRecord(piAiRecordKey(), async () => piAiGrantRecord(token));
    if (grantToken(await credentials.readRecord(piAiRecordKey())) !== token) {
      throw new Error(
        `${name}: the credential record at ${PI_AI_RECORD_SCOPE}/${PI_AI_PROVIDER} did not survive the write;`
        + " the consuming plugin may have changed its grant format",
      );
    }
    await credentials.set(options().oauthTokenEnv, token);
  };

  /**
   * Adopt a token this plugin can already see into the grant the route reads.
   * Runs once the credential service is available so an ambient token, or an
   * installation predating the grant, authenticates without a second sign-in.
   *
   * This is scoped to `credentials` rather than run at activation: the plugin
   * declares no service inject, so it activates before the credential plane
   * exists and an unscoped read would see nothing and silently give up.
   */
  const seedGrantFromReference = async () => {
    try {
      if (grantToken(await readGrant()) !== void 0) return;
      const existing = await resolveRawOAuthToken();
      if (existing === void 0) return;
      await storeRawOAuthToken(existing);
      ctx.logger.info(
        `${name}: adopted the existing ${options().oauthTokenEnv} token into the`
        + ` ${PI_AI_RECORD_SCOPE}/${PI_AI_PROVIDER} credential`,
      );
    } catch (error) {
      ctx.logger.warn(`${name}: could not adopt an existing token; sign in again to publish one`);
      ctx.logger.warn(error);
    }
  };
  ctx.inject(["credentials"], (credentialCtx) => {
    credentialCtx.effect(() => {
      void seedGrantFromReference();
      return () => {};
    }, `${name}: adopt an existing token`);
  });

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    }
  });

  // ── shared OAuth controller (commands + Web settings page) ────────────────
  const activeTimers = /* @__PURE__ */ new Set();
  let authGeneration = 0;
  let authFlow;
  const clearAuthTimers = () => {
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
  };
  ctx.effect(() => () => {
    authGeneration += 1;
    clearAuthTimers();
  });
  const publicFlow = (flow) => flow === void 0 ? void 0 : {
    state: flow.state,
    ...flow.verificationUri === void 0 ? {} : { verificationUri: flow.verificationUri },
    ...flow.userCode === void 0 ? {} : { userCode: flow.userCode },
    ...flow.expiresAt === void 0 ? {} : { expiresAt: flow.expiresAt },
    ...flow.message === void 0 ? {} : { message: flow.message }
  };
  const schedulePoll = (device) => {
    clearAuthTimers();
    const generation = ++authGeneration;
    let interval = device.interval;
    const deadline = Date.now() + device.expiresIn * 1000;
    authFlow = {
      state: "pending",
      verificationUri: device.verificationUri,
      userCode: device.userCode,
      expiresAt: deadline
    };
    let timer;
    const finish = (state, message) => {
      if (generation !== authGeneration) return;
      authFlow = { state, ...message === void 0 ? {} : { message } };
    };
    const tick = async () => {
      activeTimers.delete(timer);
      if (generation !== authGeneration) return;
      if (Date.now() > deadline) {
        finish("expired", "The device code expired. Start sign-in again.");
        ctx.logger.warn(`${name}: device authorization expired`);
        return;
      }
      const result = await pollDeviceFlow(device);
      if (generation !== authGeneration) return;
      if (result.state === "done") {
        try {
          await storeRawOAuthToken(result.token);
          finish("authenticated");
          ctx.logger.info(
            `${name}: GitHub Copilot sign-in completed; the ${PI_AI_PROVIDER} route can now authenticate`,
          );
        } catch (error) {
          finish("error", error instanceof Error ? error.message : String(error));
          ctx.logger.error(`${name}: failed to store the Copilot credential`);
          ctx.logger.error(error);
        }
        return;
      }
      switch (result.state) {
        case "slow-down": interval = Math.max(interval + 5, 1); break;
        case "expired": finish("expired", "The device code expired. Start sign-in again."); return;
        case "denied": finish("denied", "GitHub authorization was denied."); return;
        case "error": finish("error", result.message); return;
        default: break;
      }
      timer = setTimeout(tick, interval * 1000);
      activeTimers.add(timer);
    };
    timer = setTimeout(tick, interval * 1000);
    activeTimers.add(timer);
  };
  const authStatus = async () => {
    const record = await readGrant();
    const raw = grantToken(record) ?? await resolveRawOAuthToken();
    if (raw === void 0) return {
      authenticated: false,
      credential: options().oauthTokenEnv,
      provider: PI_AI_PROVIDER,
      ...publicFlow(authFlow) ?? { state: "signed-out" }
    };
    // Model ids are read back from the record the consuming route maintains,
    // never interrogated here: this plugin owns no catalog.
    const modelIds = grantModelIds(record);
    return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv,
      provider: PI_AI_PROVIDER,
      ...modelIds === void 0 ? {} : { modelCount: modelIds.length }
    };
  };
  const beginLogin = async () => {
    const existing = await resolveRawOAuthToken();
    if (existing !== void 0) return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv,
      provider: PI_AI_PROVIDER
    };
    if (authFlow?.state === "pending" && typeof authFlow.expiresAt === "number" && Date.now() < authFlow.expiresAt) {
      return { authenticated: false, ...publicFlow(authFlow) };
    }
    const device = await startDeviceFlow();
    schedulePoll(device);
    return { authenticated: false, ...publicFlow(authFlow) };
  };
  const logout = async () => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) throw new Error(`${name}: signing out needs the credentials service`);
    authGeneration += 1;
    clearAuthTimers();
    authFlow = { state: "signed-out" };
    // Both stores are cleared: the grant the route authenticates from, and this
    // plugin's own reference, which would otherwise be re-adopted on restart.
    await credentials.deleteRecord(piAiRecordKey());
    if ((await credentials.resolve(ref)) !== void 0) await credentials.unset(ref);
    return { authenticated: false, state: "signed-out", credential: ref, provider: PI_AI_PROVIDER };
  };

  // ── Web settings API (optional; only mounted by the web profile) ──────────
  const sendJson = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(body));
  };
  const webAction = (method, action) => async (req, res) => {
    if (req.method !== method) {
      res.setHeader("allow", method);
      sendJson(res, 405, { ok: false, error: `Use ${method}` });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, value: await action() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.inject(["webServer"], (wctx) => {
    wctx.effect(() => {
      const disposers = [
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/status",
          handler: webAction("GET", authStatus)
        }),
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/login",
          handler: webAction("POST", beginLogin)
        }),
        wctx.webServer.register({
          kind: "exact",
          path: "/github-copilot-auth/logout",
          handler: webAction("POST", logout)
        })
      ];
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, `${name}: Web OAuth routes`);
  });

  // ── slash commands (fallback for non-Web surfaces) ───────────────────────
  ctx.inject(["commands"], (cctx) => {
    cctx.commands.register({
      name: "copilot-login",
      description: "Sign in to GitHub Copilot via the device flow",
      handler: async () => {
        try {
          const status = await beginLogin();
          if (status.authenticated) return {
            kind: "success",
            text: `GitHub Copilot is already authenticated. Run /copilot-status for details.`
          };
          return {
            kind: "success",
            text: [
              "GitHub Copilot sign-in",
              `1. Open this URL in your browser: ${status.verificationUri}`,
              `2. Enter this code: ${status.userCode}`,
              "3. Authorize the GitHub App (VS Code) and complete sign-in.",
              "",
              "Polling continues in the background; your credential is stored automatically once you authorize.",
              `Then select a model under the "${PI_AI_PROVIDER}" provider in Settings → Models.`
            ].join("\n")
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    cctx.commands.register({
      name: "copilot-status",
      description: "Show GitHub Copilot authentication status",
      handler: async () => {
        try {
          const status = await authStatus();
          if (!status.authenticated) return {
            kind: "success",
            text: `GitHub Copilot is NOT signed in. Run /copilot-login to sign in, or set ${options().oauthTokenEnv}.`
          };
          return {
            kind: "success",
            text: [
              `GitHub Copilot: authenticated.`,
              `Credential published to the "${status.provider}" provider.`,
              status.modelCount === void 0
                ? "Model list is populated by that provider on its first request."
                : `Models available to this account: ${status.modelCount}`,
              `Select a model under that provider in Settings → Models.`
            ].join("\n")
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    cctx.commands.register({
      name: "copilot-logout",
      description: "Sign out of GitHub Copilot and remove the stored credential",
      handler: async () => {
        try {
          const existing = await resolveRawOAuthToken();
          const status = await logout();
          return {
            kind: "success",
            text: existing === void 0
              ? "GitHub Copilot is not signed in. Nothing to do."
              : `GitHub Copilot signed out; the "${status.provider}" credential has been removed.`
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
//#endregion

