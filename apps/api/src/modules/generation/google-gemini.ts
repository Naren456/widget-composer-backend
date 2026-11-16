import { type LlmConversation, type LlmImage, type LlmProvider, type LlmReply, LlmUnavailableError } from "./llm.js";

type GeminiPart = { text: string } | { inlineData: { mimeType: LlmImage["mediaType"]; data: string } };
type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; status?: string; message?: string };
};

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8_000;

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    ["TimeoutError", "AbortError"].includes(String((error as { name?: unknown }).name ?? "")));
}

/** Google Gemini generateContent REST adapter; credentials stay server-side. */
export function googleGeminiProvider(apiKey: string, model: string): LlmProvider {
  return {
    model,
    start(system, schema): LlmConversation {
      const schemaInstructions = `\n\nReturn one JSON object matching this schema exactly. Include every required field with the correct JSON type; do not nest or rename fields:\n${JSON.stringify(schema)}`;
      const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
      return {
        async send(text, image?: LlmImage): Promise<LlmReply> {
          const parts: GeminiPart[] = [{ text }];
          if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
          contents.push({ role: "user", parts });

          let response: Response;
          try {
            response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
              method: "POST",
              headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: `${system}${schemaInstructions}` }] },
                contents,
                generationConfig: {
                  responseMimeType: "application/json",
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                },
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
          } catch (error) {
            if (isTimeoutError(error)) throw new LlmUnavailableError("The AI provider timed out.", "LLM_ERROR");
            throw new LlmUnavailableError("Could not reach the AI provider.", "LLM_UNAVAILABLE");
          }

          let payload: GeminiResponse;
          try {
            payload = await response.json() as GeminiResponse;
          } catch (error) {
            if (isTimeoutError(error)) throw new LlmUnavailableError("The AI provider timed out while reading its response.", "LLM_ERROR");
            throw new LlmUnavailableError("The AI provider returned an unreadable response.", "LLM_ERROR");
          }

          if (!response.ok) {
            if (response.status === 429) throw new LlmUnavailableError("The AI provider is rate limiting requests.", "LLM_RATE_LIMITED");
            if (response.status === 401 || response.status === 403) {
              console.error("[generation] Google Gemini rejected the API key or access — check GEMINI_API_KEY and the Google AI Studio project");
              throw new LlmUnavailableError("The AI provider is not configured correctly.", "LLM_UNAVAILABLE");
            }
            console.error(`[generation] Google Gemini API error ${response.status}${payload.error?.status ? ` (${payload.error.status})` : ""}`);
            throw new LlmUnavailableError("The AI provider returned an error.", "LLM_ERROR");
          }

          const usage = {
            inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
          };
          const candidate = payload.candidates?.[0];
          if (candidate?.finishReason === "MAX_TOKENS") return { kind: "truncated", usage };
          if (!candidate?.content?.parts?.length || payload.promptFeedback?.blockReason) return { kind: "refusal", usage };
          const content = candidate.content.parts.map((part) => part.text ?? "").join("");
          if (!content) throw new LlmUnavailableError("The AI provider returned an empty response.", "LLM_ERROR");
          contents.push({ role: "model", parts: [{ text: content }] });
          return { kind: "output", text: content, usage };
        },
      };
    },
  };
}
