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
  /** Provider used for widget generation. Defaults to OpenRouter when its key is set. */
  LLM_PROVIDER: z.enum(["anthropic", "openrouter"]).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),

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
export const selectedLlmProvider = (c: Config) => c.LLM_PROVIDER ?? (c.OPENROUTER_API_KEY ? "openrouter" : "anthropic");
export const llmConfigured = (c: Config) => selectedLlmProvider(c) === "openrouter" ? Boolean(c.OPENROUTER_API_KEY) : Boolean(c.ANTHROPIC_API_KEY);
