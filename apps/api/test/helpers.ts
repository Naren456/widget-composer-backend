import { randomBytes } from "node:crypto";
import { type AddressInfo } from "node:net";

import { PGlite, type Transaction } from "@electric-sql/pglite";

import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";
import { type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { type ConnectedAccount, type ConnectorClient } from "../src/modules/connectors/composio.js";
import { type LlmProvider, type LlmReply } from "../src/modules/generation/llm.js";
import { type ImageGenerationProvider } from "../src/modules/image-generation/provider.js";

process.env.NODE_ENV = "test";

/** The production schema and SQL, run on PGlite (Postgres compiled to WebAssembly). */
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  const wrap = (q: PGlite | Transaction): Db => ({
    async query<T>(text: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        // Multi-statement SQL (migrations) has no parameters and must go through exec.
        const results = await q.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return { rows: (await q.query<T>(text, params)).rows };
    },
    transaction: (fn) => (q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q))),
    close: async () => {
      if (q instanceof PGlite) await q.close();
    },
  });
  const db = wrap(pg);
  await migrate(db);
  return db;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://memory",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    PUBLIC_API_URL: "https://api.test",
    CORS_ORIGINS: "http://localhost:8081",
    ...overrides,
  });
}

/** A model that replies with a fixed script, recording what it was sent. */
export function scriptedLlm(replies: (LlmReply | string)[]): LlmProvider & { sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  return {
    model: "scripted",
    sent,
    start: (_system, schema) => {
      const required = schema.required;
      const isPromptPreparation = Array.isArray(required) && required.includes("valid") && required.includes("prompt");
      return {
      async send(text) {
        if (isPromptPreparation) {
          return {
            kind: "output",
            text: JSON.stringify({ valid: true, prompt: text, reason: "" }),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        sent.push(text);
        const next = replies[Math.min(i++, replies.length - 1)];
        return typeof next === "string" ? { kind: "output", text: next, usage: { inputTokens: 10, outputTokens: 5 } } : next;
        },
      };
    },
  };
}

/** In-memory Composio: accounts per user, and tool calls answered by `handler`. */
export function fakeConnectors(
  handler: (userId: string, tool: string, args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
): ConnectorClient & { accountsByUser: Map<string, ConnectedAccount[]>; links: string[]; calls: { tool: string; args: Record<string, unknown> }[] } {
  const accountsByUser = new Map<string, ConnectedAccount[]>();
  const links: string[] = [];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    accountsByUser,
    links,
    calls,
    async connectLink(userId, toolkit, callbackUrl) {
      links.push(callbackUrl);
      return `https://connect.composio.test/${toolkit}?user=${userId}`;
    },
    async accounts(userId) {
      return accountsByUser.get(userId) ?? [];
    },
    async disconnect(accountId) {
      for (const [user, list] of accountsByUser) accountsByUser.set(user, list.filter((a) => a.id !== accountId));
    },
    async execute(userId, tool, args) {
      calls.push({ tool, args });
      return handler(userId, tool, args);
    },
  };
}

export type TestServer = {
  url: string;
  db: Db;
  config: Config;
  request: (path: string, init?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{
    status: number;
    body: any;
    headers: Headers;
  }>;
  signUp: () => Promise<{ accessToken: string; refreshToken: string; userId: string }>;
  close: () => Promise<void>;
};

export async function startServer(opts: {
  llm?: LlmProvider | null;
  connectors?: ConnectorClient | null;
  imageGenerationProvider?: ImageGenerationProvider | null;
  config?: Config;
} = {}): Promise<TestServer> {
  const db = await testDb();
  const config = opts.config ?? testConfig();
  const app = buildApp({
    db,
    config,
    llm: opts.llm ?? null,
    imageGenerator: null,
    imageGenerationProvider: opts.imageGenerationProvider ?? null,
    connectors: opts.connectors ?? null,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request: TestServer["request"] = async (path, init = {}) => {
    const res = await fetch(url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      redirect: "manual",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
    const text = await res.text();
    const isJson = res.headers.get("content-type")?.includes("application/json");
    return { status: res.status, body: text && isJson ? JSON.parse(text) : null, headers: res.headers };
  };

  return {
    url,
    db,
    config,
    request,
    signUp: async () => (await request("/v1/auth/device", { method: "POST" })).body,
    close: async () => {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

/** A small valid spec using one GitHub source. */
export function sampleSpec(name = "My PRs") {
  return {
    schemaVersion: 1,
    name,
    presentation: { theme: "dark", refreshMinutes: 30 },
    dataSources: [{ id: "prs", connector: "github", query: "open_pull_requests" }],
    root: {
      type: "column",
      gap: 8,
      children: [
        { type: "text", text: "Open PRs: {{prs.count}}", style: "title" },
        { type: "list", source: "prs", maxItems: 3 },
        { type: "button", label: "Open latest", action: { type: "open_url", urlBinding: "prs.items[0].url" } },
      ],
    },
  };
}
