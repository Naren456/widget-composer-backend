import { randomBytes } from "node:crypto";
import { type AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";

import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";
import { type GitHubApi } from "../src/modules/connectors/connector.js";
import { type ImageDescriber } from "../src/modules/generation/image-description.js";
import { type LlmProvider, type LlmReply } from "../src/modules/generation/llm.js";

process.env.NODE_ENV = "test";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Run the Prisma-backed production schema on PGlite through its PostgreSQL wire protocol. */
export type TestDb = PrismaClient & { close(): Promise<void> };

export async function testDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  const socket = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 10 });
  await socket.start();
  const connectionString = `postgresql://postgres:postgres@${socket.getServerConn()}/postgres?schema=public`;
  const client = new PrismaClient({ datasourceUrl: connectionString });
  const db = Object.assign(client, {
    close: async () => {
      await client.$disconnect();
      await socket.stop();
      await pg.close();
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(join(API_DIR, "node_modules/.bin/prisma"), [
        "migrate",
        "deploy",
        "--schema",
        join(API_DIR, "prisma/schema.prisma"),
      ], {
        cwd: API_DIR,
        env: { ...process.env, DATABASE_URL: connectionString },
      }, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
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

/** In-memory public GitHub API: search and contribution answers come from `opts`. */
export function fakeGitHub(opts: {
  search?: (qualifier: string) => unknown;
  calendar?: (username: string) => unknown;
} = {}): GitHubApi & { searchCalls: string[]; calendarCalls: string[] } {
  const searchCalls: string[] = [];
  const calendarCalls: string[] = [];
  return {
    searchCalls,
    calendarCalls,
    async searchIssues(qualifier) {
      searchCalls.push(qualifier);
      return opts.search ? await opts.search(qualifier) : { total_count: 0, items: [] };
    },
    async contributionCalendar(username) {
      calendarCalls.push(username);
      return opts.calendar ? await opts.calendar(username) : { total: 0, days: [] };
    },
  };
}

const emptyGitHub: GitHubApi = {
  searchIssues: async () => ({ total_count: 0, items: [] }),
  contributionCalendar: async () => ({ total: 0, days: [] }),
};

export type TestServer = {
  url: string;
  db: TestDb;
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
  imageDescriber?: ImageDescriber | null;
  github?: GitHubApi;
  config?: Config;
} = {}): Promise<TestServer> {
  const db = await testDb();
  const config = opts.config ?? testConfig();
  const app = buildApp({
    db,
    config,
    llm: opts.llm ?? null,
    imageDescriber: opts.imageDescriber ?? null,
    github: opts.github ?? emptyGitHub,
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
    dataSources: [{ id: "prs", connector: "github", query: "open_pull_requests", user: "octocat" }],
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
