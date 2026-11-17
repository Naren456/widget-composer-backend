import { type PrismaClient } from "@prisma/client";
import { type Config } from "./config.js";
import { type ConnectorClient } from "./modules/connectors/composio.js";
import { type LlmProvider } from "./modules/generation/llm.js";

/** Everything a request handler may touch, injected so tests can swap each part. */
export type Deps = {
  db: PrismaClient;
  config: Config;
  /** Null when no AI provider is configured; generation then answers 503. */
  llm: LlmProvider | null;
  /** Null when COMPOSIO_API_KEY is unset; connector routes then answer 503 and previews use sample data. */
  connectors: ConnectorClient | null;
};
