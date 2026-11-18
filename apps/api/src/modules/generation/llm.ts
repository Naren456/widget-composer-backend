/**
 * Provider-neutral interface for structured generation. The generation service only
 * sees conversations that return JSON text; the LangChain adapter (and the scripted
 * fake used in tests) live behind it.
 */

export type LlmUsage = { inputTokens: number; outputTokens: number };
export type LlmImage = { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };

export type LlmReply =
  | { kind: "output"; text: string; usage: LlmUsage }
  /** The model (and any fallback) declined the request. */
  | { kind: "refusal"; usage: LlmUsage }
  /** The output hit max_tokens and is incomplete. */
  | { kind: "truncated"; usage: LlmUsage };

export interface LlmConversation {
  /** Sends a user turn and returns the reply. Earlier turns are kept, append-only. */
  send(text: string, image?: LlmImage): Promise<LlmReply>;
}

export interface LlmProvider {
  readonly model: string;
  /** Starts a conversation whose replies are constrained to `schema` (JSON Schema). */
  start(system: string, schema: Record<string, unknown>): LlmConversation;
}

/** Thrown for provider failures the API should report as "try again later". */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: "LLM_RATE_LIMITED" | "LLM_UNAVAILABLE" | "LLM_ERROR",
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
