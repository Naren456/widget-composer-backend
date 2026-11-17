import assert from "node:assert/strict";
import { test } from "node:test";

import { fixWidgetPrompt, prepareWidgetPrompt } from "../src/modules/generation/prompt.js";
import { type LlmProvider } from "../src/modules/generation/llm.js";
import { explicitReferences, generateSpec, useLiveNewsSource } from "../src/modules/generation/service.js";
import { type FlatSpec } from "../src/spec/flat.js";
import { type WidgetSpec } from "../src/spec/widget-spec.js";
import { testDb } from "./helpers.js";

test("prompt fixer runs as a structured step and preserves requested URL and visual direction", async () => {
  let schemaRequired: unknown;
  const provider: LlmProvider = {
    model: "prompt-fixer-test",
    start: (_system, schema) => {
      schemaRequired = schema.required;
      return {
        async send(input) {
          assert.match(input, /https:\/\/www\.xda-developers\.com\//);
          assert.match(input, /electric blue/);
          return {
            kind: "output",
            text: JSON.stringify({
              valid: true,
              prompt: "Create a compact Android tech-news widget with a cool white palette and electric blue accent.",
              reason: "",
            }),
            usage: { inputTokens: 12, outputTokens: 18 },
          };
        },
      };
    },
  };
  const result = await fixWidgetPrompt(provider, "Create a tech widget for https://www.xda-developers.com/ with cool white and electric blue.");
  assert.deepEqual(schemaRequired, ["valid", "prompt", "reason"]);
  assert.equal(result.changed, true);
  assert.match(result.prompt, /https:\/\/www\.xda-developers\.com\//);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 18 });
});

test("prompt fixer failure safely falls back to normalized user input", async () => {
  const provider: LlmProvider = {
    model: "prompt-fixer-test",
    start: () => ({ async send() { throw new Error("temporary failure"); } }),
  };
  const result = await fixWidgetPrompt(provider, "  Show   my battery status  ");
  assert.equal(result.prompt, "Show my battery status");
  assert.equal(result.changed, false);
});

test("prompt fixer keeps short edits when the existing widget provides context", async () => {
  let submitted = "";
  const provider: LlmProvider = {
    model: "prompt-fixer-edit-test",
    start: () => ({
      async send(input) {
        submitted = input;
        return {
          kind: "output",
          text: JSON.stringify({ valid: false, prompt: "", reason: "Add a news topic." }),
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
    }),
  };
  const result = await fixWidgetPrompt(provider, "Update widget news", '{"name":"Hacker News","dataSources":[{"connector":"news"}]}');

  assert.match(submitted, /Hacker News/);
  assert.match(submitted, /Update widget news/);
  assert.equal(result.prompt, "Update widget news");
});

test("basic prompt limits are enforced before calling the fixer", () => {
  assert.throws(() => prepareWidgetPrompt("no"), { code: "INVALID_PROMPT" });
  assert.equal(prepareWidgetPrompt("  Battery\u00a0status  "), "Battery status");
});

test("explicit RSS feed URLs are kept separate from publisher webpage URLs", () => {
  const references = explicitReferences([
    "Website URL:",
    "https://www.xda-developers.com/",
    "RSS Feed URL:",
    "https://www.xda-developers.com/feed/",
    "Logo / Branding URL:",
    "https://www.xda-developers.com/",
  ].join("\n"));
  assert.deepEqual(references, [
    { url: "https://www.xda-developers.com/", kind: "website" },
    { url: "https://www.xda-developers.com/feed/", kind: "news-feed" },
  ]);
});

test("explicit URLs in Markdown links are extracted without their delimiters", () => {
  assert.deepEqual(
    explicitReferences("[https://example.com/feed.xml](https://example.com/feed.xml)"),
    [{ url: "https://example.com/feed.xml", kind: "news-feed" }],
  );
});

test("feed labels in the original prompt survive prompt rewriting", () => {
  assert.deepEqual(
    explicitReferences(
      "Create a news widget using https://publisher.example/ and https://publisher.example/latest",
      "Homepage URL:\nhttps://publisher.example/\nRSS Feed URL:\nhttps://publisher.example/latest",
    ),
    [
      { url: "https://publisher.example/", kind: "website" },
      { url: "https://publisher.example/latest", kind: "news-feed" },
    ],
  );
});

test("news intents use live story feeds rather than generic page snapshots", () => {
  const spec: WidgetSpec = {
    schemaVersion: 7,
    name: "Latest stories",
    presentation: {
      theme: "dark",
      refreshMinutes: 30,
      palette: { background: "#101820", surface: "#1C2732", text: "#F4F7FA", muted: "#ABB8C4", accent: "#F4A261", border: "#34424F" },
    },
    dataSources: [{ id: "site", connector: "website", query: "page", url: "https://publisher.example/" }],
    root: { type: "column", children: [{ type: "text", text: "{{site.items[0].title}}" }] },
  };

  assert.deepEqual(useLiveNewsSource(spec, "Create a dynamic news headlines widget").dataSources, [
    { id: "site", connector: "news", query: "latest_items", url: "https://publisher.example/" },
  ]);
  assert.equal(useLiveNewsSource(spec, "Create a site shortcut").dataSources[0].connector, "website");
});

test("generation uses existing widget context to accept a short edit", async () => {
  const db = await testDb();
  const userId = "00000000-0000-4000-8000-000000000004";
  await db.user.create({ data: { id: userId } });
  const palette = { background: "#101820", surface: "#1C2732", text: "#F4F7FA", muted: "#ABB8C4", accent: "#F4A261", border: "#34424F" };
  const base: WidgetSpec = {
    schemaVersion: 7,
    name: "Hacker News",
    presentation: {
      theme: "dark",
      refreshMinutes: 30,
      palette,
    },
    dataSources: [{ id: "news", connector: "news", query: "latest_items", url: "https://news.ycombinator.com/" }],
    root: { type: "column", children: [{ type: "text", text: "{{news.items[0].title}}" }] },
  };
  const draft: FlatSpec = {
    unsupported: null,
    name: "Hacker News",
    theme: "dark",
    fontFamily: "sans",
    palette,
    refreshMinutes: 30,
    dataSources: base.dataSources,
    rootId: "root",
    nodes: [
      { id: "root", type: "column", children: ["title"] },
      { id: "title", type: "text", text: "{{news.items[0].title}}", fontSizeDp: 16 },
    ],
  };
  const provider: LlmProvider = {
    model: "contextual-edit-test",
    start: (_system, schema) => {
      const isFixer = Array.isArray(schema.required) && schema.required.includes("valid");
      return {
        async send(text) {
          if (isFixer) {
            assert.match(text, /Hacker News/);
            assert.match(text, /news\.ycombinator\.com/);
            return {
              kind: "output",
              text: JSON.stringify({ valid: false, prompt: "", reason: "Add more detail." }),
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          assert.match(text, /Current widget:/);
          assert.match(text, /Make the title shorter/);
          return { kind: "output", text: JSON.stringify(draft), usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
    },
  };

  try {
    const result = await generateSpec(db, provider, {
      userId,
      prompt: "Make the title shorter",
      base,
      searchBaseUrl: "http://127.0.0.1:8080",
    });
    assert.equal(result.spec.name, "Hacker News");
  } finally {
    await db.close();
  }
});

test("generation fixes the prompt first and normalizes wrapped image bindings and detached nodes", async () => {
  const db = await testDb();
  const userId = "00000000-0000-4000-8000-000000000001";
  await db.user.create({ data: { id: userId } });
  const order: string[] = [];
  const draft: FlatSpec = {
    unsupported: null,
    name: "Story card",
    theme: "dark",
    fontFamily: "sans",
    palette: { background: "#101820", surface: "#1C2732", text: "#F4F7FA", muted: "#ABB8C4", accent: "#F4A261", border: "#34424F" },
    refreshMinutes: 30,
    dataSources: [{ id: "news", connector: "news", query: "latest_items", url: "https://example.com/feed" }],
    rootId: "root",
    nodes: [
      { id: "root", type: "column", children: ["cover", "title"] },
      { id: "cover", type: "image", source: "{{news.items[0].imageUrl}}", alt: "Story image" },
      { id: "title", type: "text", text: "{{news.items[0].title}}" },
      { id: "orphan", type: "divider" },
    ],
  };
  const provider: LlmProvider = {
    model: "generation-pipeline-test",
    start: (_system, schema) => {
      const isFixer = Array.isArray(schema.required) && schema.required.includes("valid");
      order.push(isFixer ? "prompt-fixer" : "schema-generator");
      return {
        async send(text) {
          return {
            kind: "output",
            text: isFixer ? JSON.stringify({ valid: true, prompt: text, reason: "" }) : JSON.stringify(draft),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
    },
  };

  try {
    const result = await generateSpec(db, provider, {
      userId,
      prompt: "Create a compact story card with an image and headline",
      searchBaseUrl: "http://127.0.0.1:8080",
    });
    assert.deepEqual(order, ["prompt-fixer", "schema-generator"]);
    assert.equal(result.spec.root.type, "column");
    if (result.spec.root.type === "column") {
      assert.deepEqual(result.spec.root.children[0], { type: "image", source: "news.items[0].imageUrl", alt: "Story image" });
      assert.equal(result.spec.root.children.length, 2);
    }
  } finally {
    await db.close();
  }
});

test("generation normalizes nested battery nodes and drops non-connector data-source labels", async () => {
  const db = await testDb();
  const userId = "00000000-0000-4000-8000-000000000002";
  await db.user.create({ data: { id: userId } });
  const nestedDraft = {
    unsupported: null,
    name: "Battery meter",
    theme: "dark",
    fontFamily: "sans",
    palette: { background: "#0E1714", surface: "#17231E", text: "#F2F6F2", muted: "#A8B8AD", accent: "#B8F36B", border: "#2A3B32" },
    refreshMinutes: 60,
    dataSources: ["device_info"],
    rootId: "root",
    nodes: [{
      id: "root",
      type: "column",
      children: [
        { id: "level", type: "device_info", metric: "battery_level", display: "progress", maxValue: 100 },
        { id: "status", type: "device_info", metric: "battery_status", label: "Charging" },
      ],
    }],
  };
  const provider: LlmProvider = {
    model: "battery-shape-test",
    start: (_system, schema) => {
      const isFixer = Array.isArray(schema.required) && schema.required.includes("valid");
      return {
        async send(text) {
          return {
            kind: "output",
            text: isFixer ? JSON.stringify({ valid: true, prompt: text, reason: "" }) : JSON.stringify(nestedDraft),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
    },
  };
  try {
    const result = await generateSpec(db, provider, {
      userId,
      prompt: "Show my battery level and charging state in a compact widget",
      searchBaseUrl: "http://127.0.0.1:8080",
    });
    assert.deepEqual(result.spec.dataSources, []);
    assert.equal(result.spec.root.type, "column");
    if (result.spec.root.type === "column") {
      assert.equal(result.spec.root.children.length, 2);
      assert.deepEqual(result.spec.root.children[0], { type: "device_info", metric: "battery_level", display: "progress" });
    }
  } finally {
    await db.close();
  }
});
