import z from "@deepseek-ai/schemastery";
// Namespace import: the APIs whose shape differs across supported Harness
// versions are reached through `llmCompat()` rather than bound statically.
import * as dshLlm from "@deepseek-ai/dsh-llm";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, offloadRequestImagesWithPolicy, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";

