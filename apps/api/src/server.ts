import { buildApp } from "./app.js";
import { composioConfigured, llmConfigured, loadConfig, selectedImageProvider, selectedLlmProvider } from "./config.js";
import { postgresDb } from "./db/db.js";
import { migrate } from "./db/migrations.js";
import { composioClient } from "./modules/connectors/composio.js";
import { anthropicProvider } from "./modules/generation/anthropic.js";
import { openRouterProvider } from "./modules/generation/openrouter.js";
import { googleGeminiProvider } from "./modules/generation/google-gemini.js";
import { openAiImageGenerator } from "./modules/generation/image-generator.js";
import { playwrightChatGptImageGenerator } from "./modules/generation/playwright-chatgpt.js";
import { nvidiaImageGenerationProvider } from "./modules/image-generation/provider.js";
import { type ImageGenerationProvider } from "./modules/image-generation/provider.js";
import { optimizeGeneratedImage } from "./modules/image-generation/service.js";

const config = loadConfig();
const db = postgresDb(config.DATABASE_URL);

const applied = await migrate(db);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

const provider = selectedLlmProvider(config);
const llm = llmConfigured(config)
  ? provider === "openrouter"
    ? openRouterProvider(config.OPENROUTER_API_KEY!, config.OPENROUTER_MODEL)
    : provider === "google"
      ? googleGeminiProvider(config.GEMINI_API_KEY!, config.GEMINI_MODEL)
      : anthropicProvider(config.ANTHROPIC_API_KEY!, config.ANTHROPIC_MODEL)
  : null;
if (!llm) console.warn(`${provider === "openrouter" ? "OPENROUTER_API_KEY" : provider === "google" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} is not set: widget generation will answer 503.`);
console.log(`Web research uses SearXNG at ${config.SEARXNG_URL} (no search API key required).`);

const connectors = composioConfigured(config) ? composioClient(config.COMPOSIO_API_KEY!, config.COMPOSIO_GITHUB_AUTH_CONFIG_ID) : null;
if (!connectors) console.warn("COMPOSIO_API_KEY is not set: GitHub connect answers 503 and previews use sample data.");

const selectedImageProviderName = selectedImageProvider(config);
const imageGenerationProvider: ImageGenerationProvider | null = selectedImageProviderName === "nvidia" && config.NVIDIA_API_KEY
  ? nvidiaImageGenerationProvider({
      apiKey: config.NVIDIA_API_KEY,
      model: config.NVIDIA_IMAGE_MODEL,
      apiUrl: config.NVIDIA_IMAGE_API_URL,
    })
  : selectedImageProviderName === "openai" && config.OPENAI_API_KEY
    ? (() => {
        const generate = openAiImageGenerator(config.OPENAI_API_KEY!, config.OPENAI_IMAGE_MODEL);
        const provider: ImageGenerationProvider = async ({ prompt }) => generate(prompt);
        provider.model = config.OPENAI_IMAGE_MODEL;
        return provider;
      })()
    : selectedImageProviderName === "playwright_chatgpt"
      ? (() => {
          const generate = playwrightChatGptImageGenerator({
            userDataDir: config.PLAYWRIGHT_USER_DATA_DIR,
            executablePath: config.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            maxImagesPerHour: config.PLAYWRIGHT_IMAGE_LIMIT_PER_HOUR,
          });
          const provider: ImageGenerationProvider = async ({ prompt }) => generate(prompt);
          provider.model = "playwright-chatgpt";
          return provider;
        })()
      : null;
const imageGenerator = imageGenerationProvider
  ? async (prompt: string) => optimizeGeneratedImage(await imageGenerationProvider({ prompt, width: 1024, height: 1024 }))
  : null;
if (!imageGenerationProvider) console.warn("Original image generation is disabled: configure NVIDIA_API_KEY, OPENAI_API_KEY, or set IMAGE_GENERATION_PROVIDER=playwright_chatgpt.");
else if (selectedImageProviderName === "playwright_chatgpt") console.log("Original image generation opens visible (headed) Chrome with the dedicated ChatGPT profile; sign in with `npm run image:login` if it is not set up.");

const app = buildApp({ db, config, llm, imageGenerator, imageGenerationProvider, connectors });

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
