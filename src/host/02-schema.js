//#region settings schema
/**
 * The Loader-owned live configuration. It configures only how the credential
 * is addressed: everything about models, endpoints, and requests belongs to
 * the harness route that consumes the credential.
 */
const Config = z.object({
  /**
   * Credential reference for the long-lived GitHub OAuth token. Reading it
   * supports an ambient `export GITHUB_COPILOT_OAUTH_TOKEN=…`; the device flow
   * writes through it as well, so an existing deployment keeps working.
   */
  oauthTokenEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_TOKEN_ENV).volatile(),
  /**
   * GitHub host to sign in against. Blank means github.com. Set it to your
   * GitHub Enterprise Cloud host (e.g. `https://bbraun.ghe.com/` or
   * `bbraun.ghe.com`); the `GITHUB_COPILOT_ENTERPRISE_URL` environment variable
   * is used when this is blank. Sign out and in again after changing it.
   */
  enterpriseUrl: z.string().default("").volatile()
});
//#endregion

