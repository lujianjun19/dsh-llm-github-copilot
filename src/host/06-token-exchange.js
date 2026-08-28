//#region token exchange
function deriveBaseUrlFromProxyEp(apiToken) {
  const match = /(?:^|;)\s*proxy-ep=([^;\s]+)/.exec(apiToken);
  if (match === null) return void 0;
  let host = match[1];
  for (const prefix of ["https://", "http://"]) if (host.startsWith(prefix)) host = host.slice(prefix.length);
  host = host.replace(/\/+$/, "");
  if (host.startsWith("proxy.")) host = "api." + host.slice("proxy.".length);
  return `https://${host}`;
}
/**
 * Exchange a long-lived GitHub token for a short-lived Copilot API token and
 * the account-specific API base URL, matching VS Code / Copilot CLI behavior.
 *
 * @param {string} rawToken - the long-lived GitHub OAuth token.
 * @param {AbortSignal} [signal] - caller cancellation; an aborted exchange
 *   surfaces its abort reason unchanged so callers can tell cancellation apart
 *   from a genuine transport failure.
 */
async function exchangeCopilotToken(rawToken, signal) {
  let response;
  try {
    response = await copilotFetch(TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        authorization: `token ${rawToken}`,
        accept: "application/json",
        "editor-version": EDITOR_VERSION,
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "user-agent": EXCHANGE_USER_AGENT
      },
      ...signal !== void 0 ? { signal } : {}
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new LlmError(`GitHub Copilot token exchange request failed`, "TRANSPORT", { cause: error });
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 || response.status === 404 ? "AUTH" : response.status >= 500 ? "SERVER" : "TRANSPORT";
    throw new LlmError(`GitHub Copilot token exchange failed (HTTP ${response.status})`, code, { status: response.status });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new LlmError("GitHub Copilot token exchange did not answer with JSON", "TRANSPORT");
  }
  const apiToken = data.token;
  if (typeof apiToken !== "string" || apiToken.length === 0) throw new LlmError("GitHub Copilot token exchange returned no token", "AUTH");
  const expiresAt = Number(data.expires_at) || Date.now() / 1000 + 1800;
  let baseUrl;
  if (typeof data.endpoints?.api === "string" && data.endpoints.api.length > 0) baseUrl = data.endpoints.api.replace(/\/+$/, "");
  if (!baseUrl) baseUrl = deriveBaseUrlFromProxyEp(apiToken);
  return { apiToken, expiresAtMs: expiresAt * 1000, baseUrl };
}
//#endregion

