import assert from "node:assert/strict";
import { test } from "node:test";

import { toFlat, toTree, type FlatSpec } from "../src/spec/flat.js";
import { SCHEMA_VERSION, validateSpec } from "../src/spec/widget-spec.js";
import { sampleSpec } from "./helpers.js";

const issuesOf = (spec: unknown) => {
  const r = validateSpec(spec);
  return r.ok ? [] : r.issues.map((i) => i.message);
};

test("a well-formed spec is valid", () => {
  assert.deepEqual(issuesOf(sampleSpec()), []);
});

test("unknown fields, node types and connectors are rejected by the schema", () => {
  const extra = { ...sampleSpec(), script: "alert(1)" };
  assert.ok(issuesOf(extra).length > 0);
  const badNode = sampleSpec();
  (badNode.root.children as unknown[]).push({ type: "webview", url: "https://evil.example" });
  assert.ok(issuesOf(badNode).length > 0);
  const badConnector = { ...sampleSpec(), dataSources: [{ id: "x", connector: "http", query: "open_pull_requests" }] };
  assert.ok(issuesOf(badConnector).length > 0);
});

test("bindings must name declared sources and the open_url action only opens item urls", () => {
  const undeclared = sampleSpec();
  (undeclared.root.children[0] as { text: string }).text = "{{issues.count}}";
  assert.ok(issuesOf(undeclared).some((m) => m.includes('undeclared data source "issues"')));

  const titleUrl = sampleSpec();
  (titleUrl.root.children[2] as { action: { urlBinding: string } }).action.urlBinding = "prs.items[0].title";
  assert.ok(issuesOf(titleUrl).some((m) => m.includes("open_url may only open")));

  const literalUrl = sampleSpec();
  (literalUrl.root.children[2] as { action: { urlBinding: string } }).action.urlBinding = "https://evil.example";
  assert.ok(issuesOf(literalUrl).some((m) => m.includes("is not a binding")));
});

test("a lock-screen button action is accepted as an explicit native action", () => {
  const spec = sampleSpec();
  spec.schemaVersion = 8;
  spec.presentation.palette = {
    background: "#141218",
    surface: "#211F26",
    text: "#E6E1E5",
    muted: "#CAC4D0",
    accent: "#D0BCFF",
    border: "#49454F",
  };
  (spec.root.children[2] as { action: { type: string } }).action = { type: "lock_screen" };
  assert.deepEqual(issuesOf(spec), []);

  const oldVersion = sampleSpec();
  (oldVersion.root.children[2] as { action: { type: string } }).action = { type: "lock_screen" };
  assert.ok(issuesOf(oldVersion).some((message) => message.includes("require WidgetSpec v8")));
});

test("depth, node count and unused sources are limited", () => {
  let node: Record<string, unknown> = { type: "text", text: "deep" };
  for (let i = 0; i < 7; i++) node = { type: "column", children: [node] };
  const deep = { ...sampleSpec(), dataSources: [], root: node };
  assert.ok(issuesOf(deep).some((m) => m.includes("nested deeper")));

  const wide = {
    ...sampleSpec(),
    dataSources: [],
    root: { type: "column", children: Array.from({ length: 4 }, () => ({ type: "column", children: Array.from({ length: 12 }, () => ({ type: "divider" })) })) },
  };
  assert.ok(issuesOf(wide).some((m) => m.includes("exceeds the limit")));

  const unused = { ...sampleSpec(), dataSources: [...sampleSpec().dataSources, { id: "extra", connector: "github", query: "assigned_issues", user: "octocat" }] };
  assert.ok(issuesOf(unused).some((m) => m.includes('"extra" is never used')));
});

test("flat output converts to a tree and back", () => {
  const spec = validateSpec(sampleSpec());
  assert.ok(spec.ok);
  const tree = toTree(toFlat(spec.spec));
  assert.ok(tree.ok);
  assert.equal(tree.spec.schemaVersion, SCHEMA_VERSION);
  assert.equal(tree.spec.name, spec.spec.name);
  assert.deepEqual(tree.spec.dataSources, spec.spec.dataSources);
  assert.deepEqual(tree.spec.root, spec.spec.root);
  assert.equal(tree.spec.presentation.theme, spec.spec.presentation.theme);
  assert.equal(tree.spec.presentation.refreshMinutes, spec.spec.presentation.refreshMinutes);
});

test("flat output rejects broken graphs and safely drops detached nodes", () => {
  const base = (nodes: FlatSpec["nodes"], rootId = "a"): FlatSpec => ({
    unsupported: null,
    name: "x",
    theme: "dark",
    refreshMinutes: 30,
    dataSources: [],
    rootId,
    nodes,
  });
  const msg = (f: FlatSpec) => {
    const r = toTree(f);
    return r.ok ? [] : r.issues.map((i) => i.message);
  };
  assert.ok(msg(base([{ id: "a", type: "column", children: ["a"] }])).some((m) => m.includes("contains itself")));
  assert.ok(msg(base([{ id: "a", type: "column", children: ["b"] }])).some((m) => m.includes("missing node")));
  assert.ok(
    msg(base([{ id: "a", type: "column", children: ["b", "b"] }, { id: "b", type: "divider" }])).some((m) =>
      m.includes("more than one place"),
    ),
  );
  const detached = toTree(base([{ id: "a", type: "divider" }, { id: "b", type: "divider" }]));
  assert.ok(detached.ok);
  if (detached.ok) assert.deepEqual(detached.spec.root, { type: "divider" });
  assert.ok(msg(base([{ id: "a", type: "divider" }, { id: "a", type: "divider" }])).some((m) => m.includes("duplicate")));
  assert.ok(msg(base([{ id: "a", type: "divider" }], "zzz")).some((m) => m.includes("no node")));
});
