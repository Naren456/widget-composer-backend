import { type Config } from "./config.js";
import { type Db } from "./db/db.js";
import { type ConnectorClient } from "./modules/connectors/composio.js";
import { type LlmProvider } from "./modules/generation/llm.js";
import { type ImageGenerator } from "./modules/generation/image-generator.js";
import { type ImageGenerationProvider } from "./modules/image-generation/provider.js";

/** Everything a request handler may touch, injected so tests can swap each part. */
export type Deps = {
  db: Db;
  config: Config;
  /** Null when no AI provider is configured; generation then answers 503. */
  llm: LlmProvider | null;
  /** Null when OPENAI_API_KEY is unset; only original image requests need this. */
  imageGenerator: ImageGenerator | null;
  /** Full image-studio provider, including dimension and optional reference-image support. */
  imageGenerationProvider: ImageGenerationProvider | null;
  /** Null when COMPOSIO_API_KEY is unset; connector routes then answer 503 and previews use sample data. */
  connectors: ConnectorClient | null;
};
