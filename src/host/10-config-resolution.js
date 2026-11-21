//#region config resolution
/**
 * Normalize a GitHub Enterprise URL or bare domain to its hostname, the form
 * pi-ai stores in a Copilot grant's `enterpriseUrl`. `https://bbraun.ghe.com/`
 * and `bbraun.ghe.com` both become `bbraun.ghe.com`; `github.com` (or blank)
 * means "no enterprise host".
 * @param {unknown} input - the configured value.
 * @returns {string | undefined} the hostname, or undefined for github.com/blank.
 * @throws {Error} when the value is not a URL or hostname.
 */
function normalizeEnterpriseDomain(input) {
  if (typeof input !== "string") return void 0;
  const trimmed = input.trim();
  if (trimmed.length === 0) return void 0;
  let hostname;
  try {
    hostname = (trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`)).hostname.toLowerCase();
  } catch {
    throw new Error(`${name}: invalid GitHub Enterprise URL/domain "${input}"`);
  }
  if (hostname.length === 0) throw new Error(`${name}: invalid GitHub Enterprise URL/domain "${input}"`);
  return hostname === GITHUB_DOTCOM || hostname === `www.${GITHUB_DOTCOM}` ? void 0 : hostname;
}

/**
 * Resolve the settings section into the facts this plugin acts on.
 * @param {object} config - the raw settings section.
 * @returns {{ oauthTokenEnv: string, enterpriseDomain?: string }} the resolved
 *   credential reference, plus the enterprise host when one is configured.
 */
function resolveAdapterOptions(config) {
  const enterpriseDomain = normalizeEnterpriseDomain(config.enterpriseUrl);
  return {
    oauthTokenEnv: credentialRef(config.oauthTokenEnv ?? DEFAULT_OAUTH_TOKEN_ENV),
    ...enterpriseDomain === void 0 ? {} : { enterpriseDomain }
  };
}

/**
 * The credential record the harness's Copilot route reads.
 * @returns {import('@deepseek-ai/dsh-credentials').CredentialKey}
 */
function piAiRecordKey() {
  return credentialKey(PI_AI_RECORD_SCOPE, PI_AI_PROVIDER);
}

/**
 * The grant payload a fresh sign-in produces.
 *
 * Only `refresh` carries information. The consuming route performs the Copilot
 * token exchange itself and writes `access`, `expires`, `availableModelIds`,
 * and the account's endpoint back into this same record, so seeding them with
 * empty values is what tells it the grant is unexchanged.
 *
 * @param {string} token - the long-lived GitHub OAuth token.
 * @param {string} [enterpriseDomain] - GitHub Enterprise host the token was
 *   issued by. pi-ai reads it as `enterpriseUrl` to exchange the token at
 *   `api.<host>` and to serve requests from `copilot-api.<host>`.
 * @returns {{ kind: 'grant', payload: object }}
 */
function piAiGrantRecord(token, enterpriseDomain) {
  return {
    kind: "grant",
    payload: {
      type: "oauth",
      refresh: token,
      access: "",
      expires: 0,
      ...enterpriseDomain === void 0 ? {} : { enterpriseUrl: enterpriseDomain }
    }
  };
}

/**
 * The enterprise host a stored grant was issued by.
 * @param {object | undefined} record - the stored credential record.
 * @returns {string | undefined} the host, or undefined for github.com / any other shape.
 */
function grantEnterpriseDomain(record) {
  if (record?.kind !== "grant") return void 0;
  const value = record.payload?.enterpriseUrl;
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

/**
 * The long-lived token inside a stored grant, when the record holds one.
 * @param {object | undefined} record - the stored credential record.
 * @returns {string | undefined} the token, or undefined for any other shape.
 */
function grantToken(record) {
  if (record?.kind !== "grant") return void 0;
  const refresh = record.payload?.refresh;
  return typeof refresh === "string" && refresh.length > 0 ? refresh : void 0;
}

/**
 * The models the consuming route recorded as available to this account. It
 * writes them during its first exchange, so this reads back what the account
 * can actually use without this plugin interrogating any endpoint.
 * @param {object | undefined} record - the stored credential record.
 * @returns {readonly string[] | undefined} model ids, when recorded.
 */
function grantModelIds(record) {
  if (record?.kind !== "grant") return void 0;
  const ids = record.payload?.availableModelIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : void 0;
}
//#endregion

