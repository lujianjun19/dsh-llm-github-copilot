//#region config resolution
/**
 * Resolve the settings section into the one fact this plugin acts on.
 * @param {object} config - the raw settings section.
 * @returns {{ oauthTokenEnv: string }} the resolved credential reference.
 */
function resolveAdapterOptions(config) {
  return {
    oauthTokenEnv: credentialRef(config.oauthTokenEnv ?? DEFAULT_OAUTH_TOKEN_ENV)
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
 * @returns {{ kind: 'grant', payload: object }}
 */
function piAiGrantRecord(token) {
  return { kind: "grant", payload: { type: "oauth", refresh: token, access: "", expires: 0 } };
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

