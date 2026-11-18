import { buildApp } from "./app.js";
import { imageDescriberSettings, loadConfig, llmSettings } from "./config.js";
import { connectDatabase } from "./db/client.js";
import { githubPublicApi } from "./modules/connectors/github-api.js";
import { langChainProvider } from "./modules/generation/langchain.js";
import { langChainImageDescriber } from "./modules/generation/image-description.js";

const config = loadConfig();
const db = await connectDatabase(config.DATABASE_URL);

const llmConfig = llmSettings(config);
const llm = llmConfig ? langChainProvider(llmConfig) : null;
const describerConfig = imageDescriberSettings(config);
const imageDescriber = describerConfig ? langChainImageDescriber(describerConfig) : null;
if (!llmConfig) console.warn("No LLM API key is set: widget generation will answer 503.");
console.log(`Web research uses SearXNG at ${config.SEARXNG_URL} (no search API key required).`);

const app = buildApp({ db, config, llm, imageDescriber, github: githubPublicApi() });

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`WidgetComposer API running on port ${config.PORT}`);
});

function shutdown() {
  server.close(async (error) => {
    if (error) {
      console.error("Error shutting down API:", error);
      process.exitCode = 1;
    }
    await db.$disconnect();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
