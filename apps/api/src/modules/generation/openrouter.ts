import { type LlmConversation, type LlmImage, type LlmProvider, type LlmReply, LlmUnavailableError } from "./llm.js";

type Message = {
  role: "system" | "user" | "assistant";
  content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
};
type CompletionResponse = {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** OpenAI-compatible OpenRouter chat completions with key custody kept on the API. */
export function openRouterProvider(apiKey: string, model: string): LlmProvider {
  return {
    model,
    start(system, schema): LlmConversation {
      // The free router may select JSON-mode models that do not enforce JSON Schema.
      // Put the exact schema in the system prompt as well as requesting JSON mode.
      const schemaInstructions = `\n\nReturn one JSON object matching this schema exactly. Include every required field with the correct JSON type; do not nest or rename fields:\n${JSON.stringify(schema)}`;
      const messages: Message[] = [{ role: "system", content: `${system}${schemaInstructions}` }];
      return {
        async send(text, image?: LlmImage): Promise<LlmReply> {
          messages.push({
            role: "user",
            content: image
              ? [
                  { type: "text", text },
                  { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
                ]
              : text,
          });
          let response: Response;
          try {
            response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                messages,
                max_tokens: 16000,
                response_format: { type: "json_object" },
                provider: { require_parameters: true },
              }),
              signal: AbortSignal.timeout(120_000),
            });
          } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError") {
              throw new LlmUnavailableError("The AI provider timed out.", "LLM_ERROR");
            }
            throw new LlmUnavailableError("Could not reach the AI provider.", "LLM_UNAVAILABLE");
          }

          if (!response.ok) {
            if (response.status === 429) throw new LlmUnavailableError("The AI provider is rate limiting requests.", "LLM_RATE_LIMITED");
            if (response.status === 401 || response.status === 403) {
              console.error("[generation] OpenRouter rejected the API key — check OPENROUTER_API_KEY");
              throw new LlmUnavailableError("The AI provider is not configured correctly.", "LLM_UNAVAILABLE");
            }
            console.error(`[generation] OpenRouter API error ${response.status}`);
            throw new LlmUnavailableError("The AI provider returned an error.", "LLM_ERROR");
          }

          const payload = (await response.json()) as CompletionResponse;
          const choice = payload.choices?.[0];
          const usage = {
            inputTokens: payload.usage?.prompt_tokens ?? 0,
            outputTokens: payload.usage?.completion_tokens ?? 0,
          };
          if (choice?.finish_reason === "length") return { kind: "truncated", usage };
          if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) return { kind: "refusal", usage };
          const content = choice?.message?.content;
          if (typeof content !== "string") throw new LlmUnavailableError("The AI provider returned an empty response.", "LLM_ERROR");
          messages.push({ role: "assistant", content });
          return { kind: "output", text: content, usage };
        },
      };
    },
  };
}
