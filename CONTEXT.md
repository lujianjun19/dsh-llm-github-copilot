# DSH GitHub Copilot credential provider

Runs the GitHub device flow and publishes its result as the credential the
DeepSeek Harness Copilot route authenticates from. It is not an LLM adapter:
model discovery, request serialization, and streaming belong to that route. See
`docs/adr/0002-narrow-to-credential-provider.md`.

## Language

**Device flow**:
The GitHub OAuth device-authorization exchange this plugin drives: request a
user code, show it, poll until the user authorizes, and receive a Long-lived
token. The only network conversation this plugin owns.
_Avoid_: login (the user-facing act, which spans the device flow and the
Handoff), OAuth (names the family, not this exchange).

**Long-lived token**:
The durable GitHub OAuth token the Device flow yields (`ghu_…`). It is not a
Copilot API token and cannot address the Copilot API directly; it is the
material from which short-lived Copilot tokens are exchanged.
_Avoid_: API key, access token (both name the short-lived token the Consuming
route derives).

**Grant record**:
The credential record carrying the Long-lived token, written where the
Consuming route reads it. Its payload format belongs to that route, not to this
plugin, so it is written verbatim and read back only for the fields this plugin
needs.
_Avoid_: credential (the plugin also uses a plain reference; the record is the
one the handoff depends on), secret.

**Handoff**:
Writing the Grant record and stopping. Everything downstream — token exchange,
refresh, endpoint derivation, model filtering, requests — is the Consuming
route's, and this plugin neither performs nor mirrors it.
_Avoid_: integration, bridge.

**Consuming route**:
The harness-provided Copilot provider that reads the Grant record and serves
model requests (`llm-pi-ai`'s `github-copilot`). Named by role because the
handoff depends on the record it reads, not on which plugin ships it.
_Avoid_: pi-ai (the library beneath it), adapter (this plugin used to be one).
