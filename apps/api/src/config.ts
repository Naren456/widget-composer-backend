import { z } from "zod";

/**
 * Environment configuration, validated once at startup so a missing or malformed
 * secret fails the boot instead of the first request that needs it.
 *
 * Optional integrations (Claude, Composio) may be left unset: their routes then answer
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

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  /** Optional image generation provider; widget generation works without it when no artwork is requested. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2.5-sunburst"),
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_IMAGE_MODEL: z.string().default("flux.2-klein-4b"),
  NVIDIA_IMAGE_API_URL: z.url().refine((url) => new URL(url).protocol === "https:", "must use HTTPS").default("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"),
  IMAGE_GENERATION_PROVIDER: z.enum(["nvidia", "openai", "playwright_chatgpt"]).optional(),
  PLAYWRIGHT_USER_DATA_DIR: z.string().default(".local/chatgpt-image-profile"),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().default("/usr/bin/google-chrome"),
  PLAYWRIGHT_IMAGE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(6),
  /** Provider used for widget generation. */
  LLM_PROVIDER: z.enum(["anthropic", "openrouter", "google"]).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),

  /** Self-hosted SearXNG base URL; requires no vendor search API key. */
  SEARXNG_URL: z.url().default("http://127.0.0.1:8080"),

  /** Composio holds connected accounts (GitHub) and their tokens. */
  COMPOSIO_API_KEY: z.string().optional(),
  /** GitHub auth config to connect with; unset uses the project's existing one or a Composio-managed one. */
  COMPOSIO_GITHUB_AUTH_CONFIG_ID: z.string().optional(),
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

export const composioConfigured = (c: Config) => Boolean(c.COMPOSIO_API_KEY);
export const selectedLlmProvider = (c: Config) => c.LLM_PROVIDER ?? (c.OPENROUTER_API_KEY ? "openrouter" : c.GEMINI_API_KEY ? "google" : "anthropic");
export const selectedImageProvider = (c: Config) => c.IMAGE_GENERATION_PROVIDER ?? (c.NVIDIA_API_KEY ? "nvidia" : c.OPENAI_API_KEY ? "openai" : "playwright_chatgpt");
export const llmConfigured = (c: Config) => {
  switch (selectedLlmProvider(c)) {
    case "openrouter": return Boolean(c.OPENROUTER_API_KEY);
    case "google": return Boolean(c.GEMINI_API_KEY);
    case "anthropic": return Boolean(c.ANTHROPIC_API_KEY);
  }
};
