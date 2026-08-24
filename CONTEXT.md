# DSH GitHub Copilot LLM adapter

A DeepSeek Harness LLM adapter that serves GitHub Copilot models. It speaks two
GitHub wire formats — chat-completions and the OpenAI Responses API — and
translates each into the harness stream vocabulary.

## Language

**Block**:
One unit of assistant output within a single model response — text, reasoning,
or a tool-call — with a `start → delta → end` lifecycle. Mirrors the harness
`StreamChunk` block vocabulary (`block-start` / `block-end`, `ToolCallBlock`).
_Avoid_: chunk (a chunk is a single stream event, not the whole unit), segment.

**Block stream**:
The ordered, index-assigned sequence of Blocks the adapter produces from either
wire format. Owns index allocation, block ordering, lifecycle emission, and the
terminal usage/finish rule.
_Avoid_: accumulator, buffer.

**Wire format**:
One of the two GitHub transports the adapter serializes to and translates from:
chat-completions (`/chat/completions`) or the Responses API (`/responses`).
Routing between them is per-model, driven by the catalog's advertised endpoints.
_Avoid_: protocol (overloaded), API.

**Durable image**:
An admitted image retained in conversation history by immutable attachment reference, regardless of whether it originated from user input, a command, or a tool result.
_Avoid_: uploaded image (not every image originates from an upload), raw image.

**Request image**:
The model-route-specific, transient representation of a Durable image sent to a provider. Transforming or omitting it to meet request limits never changes durable conversation history.
_Avoid_: attachment (the durable reference and its request representation are different concepts), thumbnail.

**Image overflow policy**:
The route-level rule applied when Request images exceed provider or local resource limits. `error` rejects the request; `offload-oldest` replaces eligible older Request images while preserving their Durable images.
_Avoid_: truncation (text and images have different selection and replacement rules).

**Protected request image**:
A Request image originating in the most recent human-authored message or the newest tool-result image batch. It is never eligible for `offload-oldest`; current human images take precedence, and a request that cannot retain them with the newest tool images fails instead.
_Avoid_: current image (message recency alone does not capture user intent or tool-batch replacement).
