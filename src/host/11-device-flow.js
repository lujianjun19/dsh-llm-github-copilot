//#region device flow
/**
 * A device-flow failure. Carries a code so callers can distinguish transport
 * from server refusal, replacing the `LlmError` this plugin used while it was
 * an LLM adapter — nothing here is an LLM concern any more.
 */
class CopilotAuthError extends Error {
  /**
   * @param {string} message - human-readable failure.
   * @param {string} code - stable machine-readable tag.
   * @param {{ cause?: unknown, status?: number }} [details]
   */
  constructor(message, code, details = {}) {
    super(message, details.cause === void 0 ? void 0 : { cause: details.cause });
    this.name = "CopilotAuthError";
    this.code = code;
    if (details.status !== void 0) this.status = details.status;
  }
}

async function startDeviceFlow() {
  let response;
  try {
    response = await copilotFetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": EXCHANGE_USER_AGENT
      },
      body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }).toString()
    });
  } catch (error) {
    throw new CopilotAuthError("failed to start GitHub device authorization", "TRANSPORT", { cause: error });
  }
  if (!response.ok) throw new CopilotAuthError(`GitHub device authorization failed (HTTP ${response.status})`, response.status >= 500 ? "SERVER" : "TRANSPORT", { status: response.status });
  const data = await response.json();
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  if (typeof deviceCode !== "string" || deviceCode.length === 0 || typeof userCode !== "string" || userCode.length === 0) throw new CopilotAuthError("GitHub did not return a device code", "TRANSPORT");
  return {
    deviceCode,
    userCode,
    verificationUri: typeof data.verification_uri === "string" && data.verification_uri.length > 0 ? data.verification_uri : VERIFICATION_URI,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Number(data.expires_in) || 900
  };
}
async function pollDeviceFlow(device) {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    device_code: device.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
  }).toString();
  let response;
  try {
    response = await copilotFetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": EXCHANGE_USER_AGENT
      },
      body
    });
  } catch {
    return { state: "retry" };
  }
  if (!response.ok) return { state: "retry" };
  const data = await response.json();
  if (typeof data.access_token === "string" && data.access_token.length > 0) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "retry" };
    case "slow_down": return { state: "slow-down" };
    case "expired_token": return { state: "expired" };
    case "access_denied": return { state: "denied" };
    default: return { state: "error", message: data.error ?? "unknown" };
  }
}
//#endregion

