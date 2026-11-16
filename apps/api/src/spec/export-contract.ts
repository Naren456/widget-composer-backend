import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { compile } from "json-schema-to-typescript";
import { z } from "zod";

import { COMPONENT_CATALOG, WIDGET_ACTIONS } from "./component-catalog.js";
import { DATA_PROVIDER_CATALOG } from "./provider-catalog.js";
import { RENDERERS, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, specSchema } from "./widget-spec.js";

const apiRoot = process.cwd();
const appRootArg = process.argv.find((arg) => arg.startsWith("--app-root="))?.slice("--app-root=".length);
const appRoot = path.resolve(apiRoot, appRootArg ?? "../../../web2widgets");
const check = process.argv.includes("--check");

const schema = z.toJSONSchema(specSchema, { unrepresentable: "any" });
schema.$schema = "https://json-schema.org/draft/2020-12/schema";
schema.title = "WidgetSpec";
schema.description = "Declarative, versioned WidgetComposer component tree.";
const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
const schemaHash = createHash("sha256").update(schemaText).digest("hex");
const generatedTypes = await compile(JSON.parse(schemaText), "WidgetSpec", {
  bannerComment: "",
  ignoreMinAndMaxItems: true,
});
const typeText = [
  "/* Generated from the backend WidgetSpec Zod schema. Do not edit by hand. */",
  `export const WIDGET_CONTRACT_VERSION = ${SCHEMA_VERSION} as const;`,
  `export const WIDGET_CONTRACT_SHA256 = "${schemaHash}" as const;`,
  generatedTypes.trimEnd(),
  'export type WidgetNode = WidgetSpec["root"];',
  'export type WidgetPalette = NonNullable<WidgetSpec["presentation"]["palette"]>;',
  'export type WidgetAction = Extract<WidgetNode, { type: "button" }>["action"];',
  "",
].join("\n");

const kotlinSet = (values: readonly string[]) => `setOf(${values.map((value) => `"${value}"`).join(", ")})`;
const kotlinText = [
  "// Generated from the backend WidgetSpec registries. Do not edit by hand.",
  "package expo.modules.widgetruntime",
  "",
  "internal object WidgetContract {",
  `  const val CURRENT_SCHEMA_VERSION = ${SCHEMA_VERSION}`,
  `  const val SCHEMA_SHA256 = "${schemaHash}"`,
  `  val SUPPORTED_SCHEMA_VERSIONS = setOf(${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
  `  val COMPONENT_TYPES = ${kotlinSet(COMPONENT_CATALOG.map(({ type }) => type))}`,
  `  val ACTION_TYPES = ${kotlinSet(WIDGET_ACTIONS)}`,
  `  val PROVIDER_IDS = ${kotlinSet(DATA_PROVIDER_CATALOG.map(({ id }) => id))}`,
  `  val RENDERER_IDS = ${kotlinSet(Object.keys(RENDERERS))}`,
  "}",
  "",
].join("\n");

const outputs = [
  { file: path.join(apiRoot, "src/spec/widget-spec.schema.json"), content: schemaText },
];
if (existsSync(appRoot)) {
  outputs.push(
    { file: path.join(appRoot, "src/services/widget-contract.generated.ts"), content: typeText },
    {
      file: path.join(
        appRoot,
        "modules/widget-runtime/android/src/main/java/expo/modules/widgetruntime/WidgetContract.kt",
      ),
      content: kotlinText,
    },
  );
}

let stale: string[] = [];
for (const output of outputs) {
  if (check) {
    let existing: string;
    try {
      existing = await readFile(output.file, "utf8");
    } catch {
      stale.push(path.relative(apiRoot, output.file));
      continue;
    }
    if (existing !== output.content) stale.push(path.relative(apiRoot, output.file));
  } else {
    await mkdir(path.dirname(output.file), { recursive: true });
    await writeFile(output.file, output.content);
  }
}

if (check && stale.length) {
  console.error(`Widget contract artifacts are stale. Run npm run contract:generate.\n${stale.map((file) => `- ${file}`).join("\n")}`);
  process.exitCode = 1;
} else if (check) {
  console.log(`Widget contract artifacts match schema v${SCHEMA_VERSION}${existsSync(appRoot) ? " across both repositories" : ""}.`);
} else {
  console.log(`Generated WidgetSpec v${SCHEMA_VERSION} artifacts${existsSync(appRoot) ? " for backend, app and Android" : " for backend"}.`);
}
