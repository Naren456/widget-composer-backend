import { buildApp } from "./app.js";
import { composioConfigured, llmConfigured, loadConfig, selectedLlmProvider } from "./config.js";
import { postgresDb } from "./db/db.js";
import { migrate } from "./db/migrations.js";
import { composioClient } from "./modules/connectors/composio.js";
import { anthropicProvider } from "./modules/generation/anthropic.js";
import { openRouterProvider } from "./modules/generation/openrouter.js";

const config = loadConfig();
const db = postgresDb(config.DATABASE_URL);

const applied = await migrate(db);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

const provider = selectedLlmProvider(config);
const llm = llmConfigured(config)
  ? provider === "openrouter"
    ? openRouterProvider(config.OPENROUTER_API_KEY!, config.OPENROUTER_MODEL)
    : anthropicProvider(config.ANTHROPIC_API_KEY!, config.ANTHROPIC_MODEL)
  : null;
if (!llm) console.warn(`${provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"} is not set: widget generation will answer 503.`);
console.log(`Web research uses SearXNG at ${config.SEARXNG_URL} (no search API key required).`);

const connectors = composioConfigured(config) ? composioClient(config.COMPOSIO_API_KEY!, config.COMPOSIO_GITHUB_AUTH_CONFIG_ID) : null;
if (!connectors) console.warn("COMPOSIO_API_KEY is not set: GitHub connect answers 503 and previews use sample data.");

const app = buildApp({ db, config, llm, connectors });

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`WidgetComposer API running on port ${config.PORT}`);
});

function shutdown() {
  server.close(async (error) => {
    if (error) {
      console.error("Error shutting down API:", error);
      process.exitCode = 1;
    }
    await db.close();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
