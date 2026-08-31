//#region settings schema
/**
 * The plugin's settings section. It configures only how the credential is
 * addressed: everything about models, endpoints, and requests now belongs to
 * the harness route that consumes the credential.
 */
const Config = z.object({
  /**
   * Credential reference for the long-lived GitHub OAuth token. Reading it
   * supports an ambient `export GITHUB_COPILOT_OAUTH_TOKEN=…`; the device flow
   * writes through it as well, so an existing deployment keeps working.
   */
  oauthTokenEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_TOKEN_ENV)
});
//#endregion

