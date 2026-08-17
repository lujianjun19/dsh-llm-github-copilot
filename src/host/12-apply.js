//#region apply
function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
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

  // ── credential resolution ────────────────────────────────────────────────
  const resolveRawOAuthToken = async () => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0 && hit.value.length > 0) return assertUsableApiKey(hit.value, name, ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, name, ref);
    }
    return void 0;
  };
  const storeRawOAuthToken = async (token) => {
    const ref = options().oauthTokenEnv;
    const credentials = ctx.get("credentials");
    if (credentials === void 0) throw new LlmError(`GitHub Copilot sign-in needs the credentials service to store ${ref}`, "MISSING_CREDENTIAL");
    await credentials.set(ref, token);
  };

  // ── Copilot token exchange cache ─────────────────────────────────────────
  let exchangeCache;
  const resolveConnection = async () => {
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) throw new LlmError(`GitHub Copilot: no GitHub OAuth token; run /copilot-login or store ${options().oauthTokenEnv}`, "MISSING_CREDENTIAL");
    const cached = exchangeCache;
    if (cached !== void 0 && cached.raw === raw && Date.now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) return cached.connection;
    const exchanged = await exchangeCopilotToken(raw);
    const connection = {
      apiToken: exchanged.apiToken,
      baseUrl: exchanged.baseUrl ?? options().baseURL ?? DEFAULT_BASE_URL
    };
    exchangeCache = { raw, expiresAtMs: exchanged.expiresAtMs, connection };
    return connection;
  };

  // ── model catalog discovery ─────────────────────────────────────────────
  let catalogCache;
  const catalog = async () => {
    const configured = options().models;
    const cached = catalogCache;
    if (cached !== void 0 && Date.now() < cached.at + CATALOG_TTL_MS) return cached.models;
    // Never advertise models that cannot be called. In particular, the old
    // DEFAULT_MODELS fallback made an unauthenticated provider look usable in
    // every model picker even though every request would fail MISSING_CREDENTIAL.
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) {
      const models = [];
      catalogCache = { at: Date.now(), models };
      return models;
    }
    try {
      const connection = await resolveConnection();
      const response = await copilotFetch(`${connection.baseUrl}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${connection.apiToken}`,
          accept: "application/json",
          "copilot-integration-id": INTEGRATION_ID,
          "editor-version": EDITOR_VERSION,
          ...attributionHeaders()
        }
      });
      if (!response.ok) throw new LlmError(`GitHub Copilot /models answered ${response.status}`, "DISCOVERY_FAILED");
      const discovered = readModelsListing(await response.json());
      if (discovered !== void 0) {
        catalogCache = { at: Date.now(), models: discovered };
        return discovered;
      }
    } catch (error) {
      ctx.logger.warn(`${name}: model discovery failed; using configured or default catalog`);
      ctx.logger.warn(error);
    }
    // A configured static catalog is only a metadata fallback for an account
    // that has a credential. Without an explicit catalog, failed token
    // exchange/discovery advertises no models rather than eight unusable ones.
    const fallback = configured.length > 0 ? configured : [];
    catalogCache = { at: Date.now(), models: fallback };
    return fallback;
  };
  const resolveModel = async (provider, model) => {
    const models = await catalog();
    const configured = models.find((entry) => entry.id === model);
    return {
      ...configured === void 0 ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? options().defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? options().defaultMaxTokens
    };
  };

  // ── adapter + registrations ──────────────────────────────────────────────
  const adapter = new GitHubCopilotAdapter({
    options,
    catalog,
    resolveModel,
    resolveConnection,
    resolveAttachments: () => ctx.get("attachments")
  });
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs: NS,
    settingsPath: []
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  // Credential writes are a separate configuration plane. Whenever this
  // plugin's OAuth reference changes (our device flow, Settings, or an
  // external credentials-file edit), invalidate both token/catalog caches and
  // re-commit the adapter route. That emits llm/adapters-updated; every open
  // browser model directory then refetches session.models automatically.
  ctx.on("credentials/updated", (ref) => {
    if (ref !== options().oauthTokenEnv) return;
    exchangeCache = void 0;
    catalogCache = void 0;
    registration.replace([PROVIDER]);
  });
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const models = await catalog();
    return models;
  });
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts
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
          // credentials.set emits credentials/updated after its durable
          // commit; the listener above invalidates caches and refreshes every
          // open model directory before this flow settles authenticated.
          await storeRawOAuthToken(result.token);
          finish("authenticated");
          ctx.logger.info(`${name}: GitHub Copilot sign-in completed; token stored as ${options().oauthTokenEnv}`);
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
    const raw = await resolveRawOAuthToken();
    if (raw === void 0) return {
      authenticated: false,
      credential: options().oauthTokenEnv,
      ...publicFlow(authFlow) ?? { state: "signed-out" }
    };
    const models = await catalog();
    return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv,
      modelCount: models.length,
      models: models.map((model) => ({ id: model.id, name: model.name ?? model.id }))
    };
  };
  const beginLogin = async () => {
    const existing = await resolveRawOAuthToken();
    if (existing !== void 0) return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv
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
    if (credentials === void 0) throw new LlmError("GitHub Copilot sign-out needs the credentials service", "MISSING_CREDENTIAL");
    const existing = await resolveRawOAuthToken();
    authGeneration += 1;
    clearAuthTimers();
    authFlow = { state: "signed-out" };
    exchangeCache = void 0;
    catalogCache = void 0;
    // credentials.unset emits credentials/updated after its durable commit;
    // the shared listener refreshes model directories back to the fallback
    // catalog. An already-absent credential needs no additional announcement.
    if (existing !== void 0) await credentials.unset(ref);
    return { authenticated: false, state: "signed-out", credential: ref };
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
      description: "Sign in to GitHub Copilot via the device flow and register its models",
      handler: async () => {
        try {
          const status = await beginLogin();
          if (status.authenticated) return {
            kind: "success",
            text: `GitHub Copilot is already authenticated (credential ${options().oauthTokenEnv}). Run /copilot-status for details.`
          };
          return {
            kind: "success",
            text: [
              "GitHub Copilot sign-in",
              `1. Open this URL in your browser: ${status.verificationUri}`,
              `2. Enter this code: ${status.userCode}`,
              "3. Authorize the GitHub App (VS Code) and complete sign-in.",
              "",
              "Polling continues in the background; your token is stored automatically once you authorize. Check /copilot-status afterwards."
            ].join("\n")
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
    cctx.commands.register({
      name: "copilot-status",
      description: "Show GitHub Copilot authentication and model status",
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
              `GitHub Copilot: authenticated (credential ${status.credential}).`,
              `Models available: ${status.modelCount}`,
              ...status.models.slice(0, 30).map((model) => `- ${model.id}`)
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
              ? `GitHub Copilot is not signed in (no token found for ${status.credential}). Nothing to do.`
              : `GitHub Copilot signed out. Credential ${status.credential} has been removed. Run /copilot-login to sign in again.`
          };
        } catch (error) {
          return { kind: "error", text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
//#endregion