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
