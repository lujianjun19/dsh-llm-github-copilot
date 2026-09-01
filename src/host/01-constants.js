//#region constants
/** Plugin identity for the loader and its owned settings namespace. */
const name = "llm-github-copilot";

/**
 * No service inject. This plugin no longer registers an LLM adapter: it
 * provisions the credential the harness's own Copilot route consumes, and both
 * surfaces it touches (`credentials`, `commands`, `webServer`) are resolved
 * dynamically so a composition lacking them still loads.
 */
const inject = [];
const NS = settingsNamespace("llm-github-copilot");

const DISPLAY_NAME = "GitHub Copilot";

/**
 * The credential record this plugin writes, and the harness route that reads
 * it. The scope is `llm-pi-ai`'s own `RECORD_SCOPE` and the id is its pi-ai
 * provider id, because the record's format belongs to that plugin — see
 * `docs/adr/0002-narrow-to-credential-provider.md`.
 */
const PI_AI_RECORD_SCOPE = "llm-pi-ai";
const PI_AI_PROVIDER = "github-copilot";

/**
 * Credential reference holding the long-lived GitHub OAuth token. The grant
 * record is the store of record; this reference remains supported as an
 * ambient input (`export GITHUB_COPILOT_OAUTH_TOKEN=…`) and is seeded into the
 * grant on activation.
 */
const DEFAULT_OAUTH_TOKEN_ENV = "GITHUB_COPILOT_OAUTH_TOKEN";

/**
 * The default GitHub host. A GitHub Enterprise sign-in substitutes its own
 * domain everywhere this host appears: the device flow below, and — in the
 * consuming route, keyed off the grant's `enterpriseUrl` — the Copilot token
 * exchange and API.
 */
const GITHUB_COM = "github.com";

/**
 * Device-flow endpoints for one GitHub host. The verification URI is only a
 * fallback: GitHub returns its own in the device-code response.
 */
function deviceFlowEndpoints(domain) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    verificationUri: `https://${domain}/login/device`
  };
}

/**
 * Normalize a GitHub Enterprise domain or URL to its bare hostname.
 * @param {string | undefined} input - what the user typed; blank means github.com.
 * @returns {string | undefined | null} the hostname, undefined for github.com, null for unparseable input.
 */
function normalizeEnterpriseDomain(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return void 0;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname || null;
  } catch {
    return null;
  }
}

/** VS Code's public GitHub App client id — produces ghu_* tokens that can be exchanged. */
const OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const OAUTH_SCOPE = "read:user";

/** Identity headers the device flow sends, matching the Copilot editor clients. */
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const EXCHANGE_USER_AGENT = "GitHubCopilotChat/0.35.0";
//#endregion

