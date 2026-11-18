import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { type LlmConversation, type LlmImage, type LlmProvider, type LlmReply, LlmUnavailableError } from "./llm.js";

/**
 * Single LangChain adapter for every OpenAI-compatible chat endpoint (NVIDIA NIM,
 * OpenRouter, ...). ChatOpenAI owns transport, retries and token accounting, so
 * adding a provider is a base URL plus a key — no hand-rolled fetch/JSON code.
 */

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8_000;

export type LangChainOptions = {
  apiKey: string;
  model: string;
  provider: string;
  baseURL?: string;
  headers?: Record<string, string>;
};

export function langChainProvider(options: LangChainOptions): LlmProvider {
  const { apiKey, model, provider, baseURL, headers } = options;
  const chat = new ChatOpenAI({
    apiKey,
    model,
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
    configuration: { baseURL, defaultHeaders: headers },
  });

  return {
    model,
    start(system, schema): LlmConversation {
      const messages: BaseMessage[] = [
        new SystemMessage(`${system}\n\nReturn one JSON object matching this schema exactly. Include every required field with the correct JSON type; do not nest or rename fields:\n${JSON.stringify(schema)}`),
      ];

      return {
        async send(text, image?: LlmImage): Promise<LlmReply> {
          messages.push(
            image
              ? new HumanMessage({
                  content: [
                    { type: "text", text },
                    { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
                  ],
                })
              : new HumanMessage(text),
          );

          let response: AIMessage;
          try {
            response = await chat.invoke(messages);
          } catch (error) {
            throw toUnavailable(provider, error);
          }

          const usage = {
            inputTokens: response.usage_metadata?.input_tokens ?? 0,
            outputTokens: response.usage_metadata?.output_tokens ?? 0,
          };
          const content = typeof response.content === "string"
            ? response.content
            : response.content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("");
          messages.push(new AIMessage(content));

          const finishReason = response.response_metadata?.finish_reason;
          if (finishReason === "length") return { kind: "truncated", usage };
          if (finishReason === "content_filter" || response.additional_kwargs?.refusal) return { kind: "refusal", usage };
          if (!content) throw new LlmUnavailableError("The AI provider returned an empty response.", "LLM_ERROR");
          return { kind: "output", text: content, usage };
        },
      };
    },
  };
}

function toUnavailable(provider: string, error: unknown): LlmUnavailableError {
  const status = Number((error as { status?: unknown } | null)?.status);
  const name = String((error as { name?: unknown } | null)?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError" || name === "APIConnectionTimeoutError" || status === 408) {
    return new LlmUnavailableError("The AI provider timed out.", "LLM_ERROR");
  }
  if (status === 429) return new LlmUnavailableError("The AI provider is rate limiting requests.", "LLM_RATE_LIMITED");
  if (status === 401 || status === 403) {
    console.error(`[generation] ${provider} rejected the API key — check the configured key`);
    return new LlmUnavailableError("The AI provider is not configured correctly.", "LLM_UNAVAILABLE");
  }
  if (status === 404 || status === 410) {
    console.error(`[generation] ${provider} model is unavailable — pick a current model`);
    return new LlmUnavailableError("The configured AI model is no longer available.", "LLM_UNAVAILABLE");
  }
  if (status >= 400) {
    console.error(`[generation] ${provider} API error ${status}`);
    return new LlmUnavailableError("The AI provider returned an error.", "LLM_ERROR");
  }
  return new LlmUnavailableError("Could not reach the AI provider.", "LLM_UNAVAILABLE");
}
