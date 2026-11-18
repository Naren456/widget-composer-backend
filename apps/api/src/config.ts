import { z } from "zod";

/**
 * Environment configuration, validated once at startup so a missing or malformed
 * secret fails the boot instead of the first request that needs it.
 *
 * Optional integrations (the LLM provider) may be left unset: its routes then answer
 * 503 with a clear message rather than the server refusing to start.
 */

const key32 = z
  .string()
  .transform((raw, ctx) => {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      ctx.addIssue({ code: "custom", message: "must be 32 bytes, as 64 hex characters or base64" });
      return z.NEVER;
    }
    return buf;
  });

const list = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public base URL of this API, used to build the connect callback URL. */
  PUBLIC_API_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),

  /** Signs access tokens. */
  SESSION_SECRET: key32,

  /** NVIDIA API (OpenAI-compatible) used through LangChain for widget generation. */
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_MODEL: z.string().default("nvidia/nemotron-3-ultra-550b-a55b"),
  /** Provider used for widget generation. */
  LLM_PROVIDER: z.enum(["nvidia", "openrouter"]).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),

  /** Self-hosted SearXNG base URL; requires no vendor search API key. */
  SEARXNG_URL: z.url().default("http://127.0.0.1:8080"),

  /** Where the connect callback sends the user afterwards — the app's deep link. */
  APP_REDIRECT_URL: z.string().default("web2widgets://connections"),

  /** Browser origins allowed to call the API (the Expo web build). Native apps need none. */
  CORS_ORIGINS: list,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

export type LlmSettings = {
  provider: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  headers?: Record<string, string>;
};

/** Resolve the selected provider into LangChain options; null when its key is unset. */
export function llmSettings(c: Config): LlmSettings | null {
  const provider = c.LLM_PROVIDER ?? (c.OPENROUTER_API_KEY ? "openrouter" : "nvidia");
  if (provider === "openrouter") {
    return c.OPENROUTER_API_KEY
      ? {
          provider,
          apiKey: c.OPENROUTER_API_KEY,
          model: c.OPENROUTER_MODEL,
          baseURL: "https://openrouter.ai/api/v1",
          headers: { "HTTP-Referer": c.PUBLIC_API_URL, "X-Title": "WidgetComposer" },
        }
      : null;
  }
  return c.NVIDIA_API_KEY
    ? { provider, apiKey: c.NVIDIA_API_KEY, model: c.NVIDIA_MODEL, baseURL: "https://integrate.api.nvidia.com/v1" }
    : null;
}

export const llmConfigured = (c: Config) => llmSettings(c) !== null;
