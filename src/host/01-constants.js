//#region constants
/** Plugin identity for the loader and its owned settings namespace. */
const name = "llm-github-copilot";
const inject = ["llm"];
const NS = settingsNamespace("llm-github-copilot");

/** The single provider route this plugin owns. Suffixed to avoid pi-ai's dormant `github-copilot` catalog route. */
const PROVIDER = "github-copilot-official";
const DISPLAY_NAME = "GitHub Copilot";

/** Credential reference holding the long-lived GitHub OAuth token from the device flow. */
const DEFAULT_OAUTH_TOKEN_ENV = "GITHUB_COPILOT_OAUTH_TOKEN";

/** Default Copilot API host; the token exchange advertises the account-specific one when it differs. */
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

/** GitHub OAuth device-flow endpoints (github.com). */
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const VERIFICATION_URI = "https://github.com/login/device";

/** Endpoint that exchanges a GitHub token for a short-lived Copilot API token. */
const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";

/** VS Code's public GitHub App client id — produces ghu_* tokens that can be exchanged. */
const OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const OAUTH_SCOPE = "read:user";

/** Copilot integrator identity selecting the broadest model allowlist. */
const INTEGRATION_ID = "vscode-chat";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
const EXCHANGE_USER_AGENT = "GitHubCopilotChat/0.35.0";

/** Defaults for models the endpoint does not size. */
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;

/** Refresh the short-lived Copilot token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 120000;

/**
 * The Harness event emitted after a stored credential reference is written or
 * removed. In Harness 0.1.1-rc.2+ this replaced the legacy
 * `credentials/updated` event, which is no longer emitted.
 */
const CREDENTIALS_EVENT = "credentials/reference-updated";

/** How long a discovered model catalog is reused before re-interrogating the endpoint. */
const CATALOG_TTL_MS = 300000;

/**
 * How long an empty/failed catalog is reused before retrying. Kept short so a
 * re-login (or a transient discovery failure) recovers within seconds instead
 * of leaving the model picker empty for the full positive TTL.
 */
const NEGATIVE_CATALOG_TTL_MS = 5000;

/** Request-image overflow strategy applied when Provider/local limits are exceeded. */
const DEFAULT_IMAGE_OVERFLOW_POLICY = "offload-oldest";

/** Default pixel budget per request image: 2048 × 2048. */
const DEFAULT_IMAGE_PIXEL_BUDGET = 4194304;

/** Default maximum total Base64 payload for all request images in one request (20 MiB). */
const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

/** Default byte quantum for inline image offload (10 MiB). */
const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024;

/** Default per-request-image maxBytes when the model does not publish a size limit (4 MiB). */
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Conservative fallback catalog used only when discovery and configuration name no models. */
const DEFAULT_MODELS = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4o-mini", name: "GPT-4o mini" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", endpoints: ["/responses"] },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }
];

/** Display names for reasoning-effort ids Copilot models declare via `supports.reasoning_effort`. */
const EFFORT_NAMES = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

/**
 * Reasoning levels for Claude-family models. Copilot does not declare a
 * `reasoning_effort` list for them — only a thinking budget — and rejects
 * `reasoning_effort` outright; the accepted control is Anthropic adaptive
 * thinking (`thinking: { type: "enabled", effort }`), whose levels are
 * low/medium/high across the family.
 */
const CLAUDE_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" }
];
//#endregion

