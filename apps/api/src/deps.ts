import { type PrismaClient } from "@prisma/client";
import { type Config } from "./config.js";
import { type GitHubApi } from "./modules/connectors/connector.js";
import { type LlmProvider } from "./modules/generation/llm.js";

/** Everything a request handler may touch, injected so tests can swap each part. */
export type Deps = {
  db: PrismaClient;
  config: Config;
  /** Null when no AI provider is configured; generation then answers 503. */
  llm: LlmProvider | null;
  /** Public GitHub API reader; GitHub data sources carry their own username. */
  github: GitHubApi;
};
