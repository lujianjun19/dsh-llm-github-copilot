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
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = config.oauthTokenEnv.get();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions({ oauthTokenEnv: raw });
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error(`${name}: keeping the last good configuration after an invalid credential reference`);
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
   *
   * The reference write is skipped when the launching environment supplies the
   * reference read-only: Harness releases before 0.2.1 reject that `set`, and
   * the environment already resolves the reference, so the grant alone suffices.
   *
   * `enterpriseDomain` is carried into the grant as `enterpriseUrl` so the
   * consuming route exchanges tokens and derives endpoints under that GitHub
   * Enterprise host; undefined keeps the github.com default.
   */
  const storeRawOAuthToken = async (token, enterpriseDomain) => {
    const credentials = ctx.get("credentials");
    if (credentials === void 0) {
      throw new Error(`${name}: signing in needs the credentials service; mount dsh-credentials-local`);
    }
    await credentials.modifyRecord(piAiRecordKey(), async () => piAiGrantRecord(token, enterpriseDomain));
    if (grantToken(await credentials.readRecord(piAiRecordKey())) !== token) {
      throw new Error(
        `${name}: the credential record at ${PI_AI_RECORD_SCOPE}/${PI_AI_PROVIDER} did not survive the write;`
        + " the consuming plugin may have changed its grant format",
      );
    }
    const ref = options().oauthTokenEnv;
    if ((await credentials.describe(ref)).writable) await credentials.set(ref, token);
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
      const record = await readGrant();
      if (grantToken(record) !== void 0) return;
      const existing = await resolveRawOAuthToken();
      if (existing === void 0) return;
      // A record that already names an enterprise host keeps it: the token is
      // being re-adopted, not re-pointed at github.com.
      await storeRawOAuthToken(existing, grantEnterpriseDomain(record));
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

  // dsh-settings owns optional presentation policy. The Loader owns this
  // plugin's volatile Config, so the device-flow controller reads its reference
  // directly and stays usable in compositions without a settings service.
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      `${name}: custom settings page`,
    );
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
    ...flow.message === void 0 ? {} : { message: flow.message },
    ...flow.enterpriseDomain === void 0 ? {} : { enterpriseDomain: flow.enterpriseDomain }
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
      expiresAt: deadline,
      ...device.domain === void 0 ? {} : { enterpriseDomain: device.domain }
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
          await storeRawOAuthToken(result.token, device.domain);
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
    const stored = grantToken(record);
    const raw = stored ?? await resolveRawOAuthToken();
    if (raw === void 0) return {
      authenticated: false,
      credential: options().oauthTokenEnv,
      provider: PI_AI_PROVIDER,
      ...publicFlow(authFlow) ?? { state: "signed-out" }
    };
    // Model ids are read back from the record the consuming route maintains,
    // never interrogated here: this plugin owns no catalog.
    const modelIds = grantModelIds(record);
    const enterpriseDomain = grantEnterpriseDomain(record);
    return {
      authenticated: true,
      state: "authenticated",
      credential: options().oauthTokenEnv,
      provider: PI_AI_PROVIDER,
      ...stored === void 0 ? { credentialRemaining: true } : {},
      ...modelIds === void 0 ? {} : { modelCount: modelIds.length },
      ...enterpriseDomain === void 0 ? {} : { enterpriseDomain }
    };
  };
  /**
   * The enterprise domain in a login request. The Web route posts
   * `{ enterpriseDomain }` and the slash command passes its raw input, so both
   * shapes arrive here; anything else means github.com.
   * @param {unknown} request - the login body or command input.
   * @returns {string | undefined} what the user typed, or undefined.
   */
  const requestedDomain = (request) => {
    if (typeof request === "string") return request;
    const domain = request?.enterpriseDomain;
    return typeof domain === "string" ? domain : void 0;
  };
  const beginLogin = async (request) => {
    const existing = await resolveRawOAuthToken();
    if (existing !== void 0) return authStatus();
    if (authFlow?.state === "pending" && typeof authFlow.expiresAt === "number" && Date.now() < authFlow.expiresAt) {
      return { authenticated: false, ...publicFlow(authFlow) };
    }
    const rawDomain = requestedDomain(request);
    const domain = normalizeEnterpriseDomain(rawDomain);
    if (domain === null) return { authenticated: false, state: "error", message: "Not a valid GitHub Enterprise domain: " + String(rawDomain) };
    const device = await startDeviceFlow(domain);
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
    // Clear managed storage, never the launching environment. Older providers
    // expose ambient references read-only; newer ones unset a file override but
    // still fall back to the environment. Report the remaining token honestly.
    await credentials.deleteRecord(piAiRecordKey());
    if ((await credentials.describe(ref)).writable && (await credentials.resolve(ref)) !== void 0) {
      await credentials.unset(ref);
    }
    return authStatus();
  };

  // ── Web settings API (optional; only mounted by the web profile) ──────────
  // `ctx.webServer.register()` is a raw, unauthenticated HTTP route: it is not
  // reachable through the browser's shared `/api` channel at all, and nothing
  // applies the harness's Host/Origin fence or browser-session check to it.
  // Login and logout must instead go through `ctx.connection.fetch.register()`,
  // whose `path` is a literal absolute path under `/api` and whose handler runs
  // only once Connection's trust and authentication policy has already passed.
  const jsonResponse = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
  /**
   * The JSON body a POST action was called with, or undefined for an empty one.
   * The route is registered with `requestBody: "buffered"`, so the request is
   * readable here; a malformed body is treated as no body at all.
   */
  const jsonBody = async (request) => {
    if (request === void 0 || request.body === null) return void 0;
    try {
      const text = await request.text();
      return text.length === 0 ? void 0 : JSON.parse(text);
    } catch {
      return void 0;
    }
  };
  const fetchAction = (action) => async (request) => {
    try {
      return jsonResponse(200, { ok: true, value: await action(await jsonBody(request)) });
    } catch (error) {
      return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  ctx.inject(["connection"], (cctx) => {
    cctx.effect(() => {
      const disposers = [
        cctx.connection.fetch.register({
          path: "/api/github-copilot-auth/status",
          methods: ["GET"],
          requestBody: "buffered",
          fetch: fetchAction(authStatus)
        }),
        cctx.connection.fetch.register({
          path: "/api/github-copilot-auth/login",
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(beginLogin)
        }),
        cctx.connection.fetch.register({
          path: "/api/github-copilot-auth/logout",
          methods: ["POST"],
          requestBody: "buffered",
          fetch: fetchAction(logout)
        })
      ];
      return async () => {
        for (const dispose of disposers.reverse()) await dispose();
      };
    }, `${name}: Web OAuth routes`);
  });

  // ── slash commands (fallback for non-Web surfaces) ───────────────────────
  const remainingCredentialNotice = (ref) => `${ref} still supplies a token outside the local grant.`
    + " Remove it from the launching environment, .env, or external credential source and restart DSH to finish signing out.";
  ctx.inject(["commands"], (cctx) => {
    cctx.commands.register({
      name: "copilot-login",
      description: "Sign in to GitHub Copilot via the device flow; pass an enterprise domain for GHE (e.g. company.ghe.com)",
      handler: async (invocation) => {
        try {
          const status = await beginLogin(invocation?.rawInput);
          if (status.credentialRemaining) return { kind: "success", text: remainingCredentialNotice(status.credential) };
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
          if (status.credentialRemaining) return { kind: "success", text: remainingCredentialNotice(status.credential) };
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
            text: status.credentialRemaining
              ? `Local GitHub Copilot grant removed, but ${remainingCredentialNotice(status.credential)}`
              : existing === void 0
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
