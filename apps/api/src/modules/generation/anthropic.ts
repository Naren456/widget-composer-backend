import Anthropic from "@anthropic-ai/sdk";

import { type LlmConversation, type LlmImage, type LlmProvider, type LlmReply, LlmUnavailableError } from "./llm.js";

/**
 * Claude adapter. Uses structured outputs (`output_config.format`) so every reply is
 * JSON matching the schema; Opus 5.5 rejects forced tool choice, and a flat schema
 * avoids the no-recursion limit of structured outputs (see spec/flat.ts).
 *
 * Server-side fallbacks are on: if the model declines, the API re-runs the request on
 * a fallback model inside the same call instead of failing it.
 */
export function anthropicProvider(apiKey: string, model: string): LlmProvider {
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });

  return {
    model,
    start(system, schema): LlmConversation {
      const messages: Anthropic.Beta.BetaMessageParam[] = [];
      return {
        async send(text, image?: LlmImage): Promise<LlmReply> {
          messages.push({
            role: "user",
            content: image
              ? [
                  { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
                  { type: "text", text },
                ]
              : text,
          });
          let response: Anthropic.Beta.BetaMessage;
          try {
            response = await client.beta.messages.create({
              model,
              max_tokens: 16000,
              system,
              messages,
              // Opus 5.5 defaults to medium; set explicitly. Thinking is always on.
              output_config: { effort: "medium", format: { type: "json_schema", schema } },
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            });
          } catch (error) {
            // Most specific first. Upstream bodies are never passed to clients.
            if (error instanceof Anthropic.RateLimitError) {
              throw new LlmUnavailableError("The AI provider is rate limiting requests.", "LLM_RATE_LIMITED");
            }
            if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
              console.error("[generation] Anthropic rejected the API key — check ANTHROPIC_API_KEY");
              throw new LlmUnavailableError("The AI provider is not configured correctly.", "LLM_UNAVAILABLE");
            }
            if (error instanceof Anthropic.APIError) {
              console.error(`[generation] Anthropic API error ${error.status}`);
              throw new LlmUnavailableError("The AI provider returned an error.", "LLM_ERROR");
            }
            throw error;
          }

          // Append the full content (thinking and fallback blocks included) so repair turns stay valid.
          messages.push({ role: "assistant", content: response.content });
          const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };

          if (response.stop_reason === "refusal") return { kind: "refusal", usage };
          if (response.stop_reason === "max_tokens") return { kind: "truncated", usage };
          const out = response.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          return { kind: "output", text: out, usage };
        },
      };
    },
  };
}
