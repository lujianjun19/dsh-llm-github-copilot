//#region constants
/** Plugin identity for the loader and its owned settings namespace. */
const name = "llm-github-copilot";

/**
 * No service inject. This plugin no longer registers an LLM adapter: it
 * provisions the credential the harness's own Copilot route consumes. The
 * services it touches (`credentials`, `commands`, `connection`, `settings`)
 * are resolved dynamically so a composition lacking them still loads.
 */
const inject = [];
const NS = "llm-github-copilot";

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
 * Ambient fallback for the GitHub host to sign in against, used when the
 * `enterpriseUrl` setting is empty (`export GITHUB_COPILOT_ENTERPRISE_URL=company.ghe.com`).
 */
const ENTERPRISE_URL_ENV = "GITHUB_COPILOT_ENTERPRISE_URL";

/** The public GitHub host, used when no enterprise host is configured. */
const GITHUB_DOTCOM = "github.com";

/**
 * GitHub OAuth device-flow endpoints for a host. github.com and GitHub
 * Enterprise Cloud with data residency (`<company>.ghe.com`) share the layout;
 * the consuming pi-ai route derives the matching token-exchange and API hosts
 * (`api.<host>`, `copilot-api.<host>`) from the grant's `enterpriseUrl`.
 * @param {string} domain - bare hostname, e.g. `github.com` or `bbraun.ghe.com`.
 */
function deviceFlowUrls(domain) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    verificationUri: `https://${domain}/login/device`
  };
}

/** VS Code's public GitHub App client id — produces ghu_* tokens that can be exchanged. */
const OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const OAUTH_SCOPE = "read:user";

/** Identity headers the device flow sends, matching the Copilot editor clients. */
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const EXCHANGE_USER_AGENT = "GitHubCopilotChat/0.35.0";
//#endregion

