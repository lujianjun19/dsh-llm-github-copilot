//#region block stream
/**
 * The Block stream: the shared, wire-agnostic assembler both translators drive.
 *
 * A **Block** is one unit of assistant output (text, reasoning, or tool-call)
 * with a `start → delta → end` lifecycle, mirroring the harness StreamChunk
 * vocabulary. This module owns index allocation, block ordering, lazy opening,
 * `block-start` / `*-delta` / `block-end` emission, and the terminal
 * usage/finish rule — everything that is identical across the chat-completions
 * and Responses wire formats.
 *
 * Wire-specific **routing** (chat keys tool calls by `call.index` in a Map;
 * Responses tracks a single reference because gpt-5.x rotates `item_id` per
 * event) stays in the translators. They hold the opaque tool handles this
 * module hands back and decide which handle a given wire event addresses.
 *
 * Interface shape: a reducer. Every method mutates internal block state and
 * *returns* the StreamChunks to emit; the translator does `yield* bs.text(d)`.
 * No method yields or performs I/O, so the whole module is unit-testable
 * through its interface without reconstructing an SSE byte stream.
 * @module dsh-llm-github-copilot/block-stream
 */
var BlockStream = class {
  #nextIndex = 0;
  #order = [];
  #text;
  #reasoning;

  #open(kind) {
    const block = { index: this.#nextIndex++, kind, text: "", closed: false };
    this.#order.push(block);
    return block;
  }

  #payload(block) {
    switch (block.kind) {
      case "text": return { type: "text", text: block.text };
      case "reasoning": return { type: "reasoning", text: block.text };
      case "tool-call": return {
        type: "tool-call",
        id: LLM.toolCallId(block.callId ?? ""),
        name: block.name ?? "",
        arguments: block.text
      };
    }
  }

  #end(block) {
    if (block.closed) return [];
    block.closed = true;
    return [{ type: "block-end", index: block.index, block: this.#payload(block) }];
  }

  /** True once at least one block has been opened — drives the empty-response rule. */
  get isEmpty() {
    return this.#order.length === 0;
  }

  /** Explicitly open the current text block (Responses content_part.added). Idempotent. */
  openText() {
    if (this.#text !== void 0 && !this.#text.closed) return [];
    this.#text = this.#open("text");
    return [{ type: "block-start", index: this.#text.index, blockType: "text" }];
  }

  /** Explicitly open the current reasoning block (Responses output_item.added). Idempotent. */
  openReasoning() {
    if (this.#reasoning !== void 0 && !this.#reasoning.closed) return [];
    this.#reasoning = this.#open("reasoning");
    return [{ type: "block-start", index: this.#reasoning.index, blockType: "reasoning" }];
  }

  /** Append a text delta, lazily opening the current text block. */
  text(delta) {
    const chunks = [];
    if (this.#text === void 0 || this.#text.closed) {
      this.#text = this.#open("text");
      chunks.push({ type: "block-start", index: this.#text.index, blockType: "text" });
    }
    this.#text.text += delta;
    chunks.push({ type: "text-delta", index: this.#text.index, text: delta });
    return chunks;
  }

  /** Append a reasoning delta, lazily opening the current reasoning block. */
  reasoning(delta) {
    const chunks = [];
    if (this.#reasoning === void 0 || this.#reasoning.closed) {
      this.#reasoning = this.#open("reasoning");
      chunks.push({ type: "block-start", index: this.#reasoning.index, blockType: "reasoning" });
    }
    this.#reasoning.text += delta;
    chunks.push({ type: "reasoning-delta", index: this.#reasoning.index, text: delta });
    return chunks;
  }

  /** True when a reasoning block is currently open (for `.done` backfill decisions). */
  get reasoningIsEmpty() {
    return this.#reasoning === void 0 || this.#reasoning.text.length === 0;
  }

  /** Close the current text block, if open. */
  closeText() {
    const block = this.#text;
    this.#text = void 0;
    return block === void 0 ? [] : this.#end(block);
  }

  /** Close the current reasoning block, if open. */
  closeReasoning() {
    const block = this.#reasoning;
    this.#reasoning = void 0;
    return block === void 0 ? [] : this.#end(block);
  }

  /** Open a tool-call block. Returns an opaque handle plus the block-start chunk. */
  openToolCall(meta) {
    const block = this.#open("tool-call");
    if (typeof meta?.name === "string") block.name = meta.name;
    if (typeof meta?.callId === "string") block.callId = meta.callId;
    return { handle: block, chunks: [{ type: "block-start", index: block.index, blockType: "tool-call" }] };
  }

  /** Append tool-call argument text on the handle, emitting a tool-call-delta. */
  toolArgs(handle, delta) {
    handle.text += delta;
    return [{
      type: "tool-call-delta",
      index: handle.index,
      id: LLM.toolCallId(handle.callId ?? ""),
      ...handle.name !== void 0 ? { name: handle.name } : {},
      argumentsDelta: delta
    }];
  }

  /**
   * Set authoritative metadata on a tool-call handle without emitting. Used for
   * the Responses `.done` full-arguments string and a late `call_id`. An
   * empty/absent `arguments` never clobbers already-captured argument text.
   */
  updateTool(handle, update) {
    if (typeof update?.name === "string") handle.name = update.name;
    if (typeof update?.callId === "string") handle.callId = update.callId;
    if (typeof update?.arguments === "string" && update.arguments.length > 0) handle.text = update.arguments;
  }

  /** Close a tool-call block by handle. Idempotent. */
  closeToolCall(handle) {
    return this.#end(handle);
  }

  /**
   * Terminal emit. Flushes any still-open blocks (in order), then `usage`, then
   * `finish`. The empty-response rule is unified: zero blocks produced and no
   * explicit `failure` yields the EMPTY_RESPONSE error, regardless of reason.
   */
  finish({ usage, reason, failure } = {}) {
    const chunks = [];
    for (const block of this.#order) chunks.push(...this.#end(block));
    if (usage !== void 0) chunks.push({ type: "usage", usage });
    if (failure !== void 0) {
      chunks.push({ type: "finish", reason: failure });
    } else if (this.isEmpty) {
      chunks.push({
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
        }
      });
    } else {
      chunks.push({ type: "finish", reason: reason ?? { kind: "stop" } });
    }
    return chunks;
  }
};
//#endregion

