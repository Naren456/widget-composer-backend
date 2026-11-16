import { z } from "zod";
import { isIP } from "node:net";
import { COMPONENT_CATALOG, WIDGET_FONT_FAMILIES, WIDGET_THEMES, type WidgetPalette } from "./component-catalog.js";

/**
 * WidgetSpec — the contract between generation, validation, storage, preview and
 * the native Android runtime. A spec is declarative data: it names components from a
 * fixed vocabulary and binds them to data that trusted connector code fetches. It can
 * never carry code, arbitrary URLs or credentials.
 *
 * Change the shape only by adding a new schemaVersion; stored versions are immutable.
 */

export const SCHEMA_VERSION = 6;

export const LIMITS = {
  maxDepth: 6,
  maxNodes: 40,
  maxTextLength: 120,
  maxLabelLength: 40,
  maxNameLength: 40,
  maxDataSources: 3,
  maxListItems: 5,
  /** Connectors return at most this many items, so bindings past it can never resolve. */
  maxItemIndex: 19,
  maxSpecBytes: 16_000,
} as const;

export const CONNECTORS = ["github", "website"] as const;
export const GITHUB_QUERIES = ["assigned_issues", "open_pull_requests", "review_requests", "contribution_streak"] as const;
export const WEBSITE_QUERIES = ["page"] as const;
/** Fields every normalized item carries; see `connectors/github.ts`. */
export const ITEM_FIELDS = ["title", "url", "repo", "number", "author", "updatedAt", "imageUrl"] as const;

export type GitHubDataSource = {
  id: string;
  connector: "github";
  query: (typeof GITHUB_QUERIES)[number];
};
export type WebsiteDataSource = { id: string; connector: "website"; query: "page"; url: string };
export type DataSource = GitHubDataSource | WebsiteDataSource;

export type AllowedAction =
  /** Opens a URL that came from connector data, never one written into the spec. */
  | { type: "open_url"; urlBinding: string }
  | { type: "open_app"; screen: "widget_details" }
  | { type: "refresh" };

export type WidgetNode =
  | { type: "column" | "row"; gap?: number; surface?: boolean; radiusDp?: number; paddingDp?: number; children: WidgetNode[] }
  /** Text may contain {{binding}} placeholders, e.g. "{{prs.count}} open". */
  | { type: "text"; text: string; style?: "title" | "body" | "caption"; fontSizeDp?: number; weight?: "normal" | "medium" | "bold"; colorToken?: "text" | "muted" | "accent" }
  /** An image supplied by a website data source, never an arbitrary spec URL. */
  | { type: "image"; source: string; alt?: string; widthDp?: number; heightDp?: number; fit?: "cover" | "contain"; radiusDp?: number }
  /** A short label that opens a URL supplied by connector data. */
  | { type: "link"; label: string; urlBinding: string }
  /** Native TextClock; uses the device's current local time and updates independently. */
  | { type: "clock"; format: "12_hour" | "24_hour"; showDate?: boolean; showSeconds?: boolean }
  | { type: "metric"; label: string; valueBinding: string }
  | { type: "progress"; label?: string; valueBinding: string; maxValue: number; widthDp?: number; heightDp?: number }
  /** The first `maxItems` items of a data source, each drawn as title + repo#number. */
  | { type: "list"; source: string; maxItems: number }
  /** GitHub contribution heatmap plus current and longest streak summary. */
  | { type: "streak_chart"; source: string }
  | { type: "divider" }
  | { type: "spacer"; sizeDp: number }
  | { type: "button"; label: string; action: AllowedAction };

export type WidgetSpec = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  presentation: {
    theme: "light" | "dark" | "system";
    /** Android system font family; Glance widgets cannot load custom app fonts. */
    fontFamily?: "sans" | "serif" | "monospace";
    palette?: WidgetPalette;
    /** A preference: Android decides when background refresh actually runs. */
    refreshMinutes: number;
    minWidthDp?: number;
    minHeightDp?: number;
  };
  dataSources: DataSource[];
  root: WidgetNode;
};

const sourceId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "lowercase letters, digits and _, starting with a letter");
const dp = z.number().int().min(0).max(64);
const imageDp = z.number().int().min(24).max(240);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six digit hex color, such as #AABBCC");
const paletteSchema = z.object({ background: color, surface: color, text: color, muted: color, accent: color, border: color }).strict();

const action: z.ZodType<AllowedAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_url"), urlBinding: z.string().max(80) }).strict(),
  z.object({ type: z.literal("open_app"), screen: z.literal("widget_details") }).strict(),
  z.object({ type: z.literal("refresh") }).strict(),
]);

export const nodeSchema: z.ZodType<WidgetNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.enum(["column", "row"]), gap: dp.optional(), surface: z.boolean().optional(), radiusDp: z.number().int().min(0).max(24).optional(), paddingDp: z.number().int().min(0).max(24).optional(), children: z.array(nodeSchema).min(1).max(12) }).strict(),
    z
      .object({
        type: z.literal("text"),
        text: z.string().min(1).max(LIMITS.maxTextLength),
        style: z.enum(["title", "body", "caption"]).optional(),
        fontSizeDp: z.number().int().min(10).max(32).optional(),
        weight: z.enum(["normal", "medium", "bold"]).optional(),
        colorToken: z.enum(["text", "muted", "accent"]).optional(),
      })
      .strict(),
    z.object({
      type: z.literal("image"), source: z.string().max(80), alt: z.string().max(120).optional(),
      widthDp: imageDp.optional(), heightDp: imageDp.optional(), fit: z.enum(["cover", "contain"]).optional(), radiusDp: z.number().int().min(0).max(24).optional(),
    }).strict(),
    z.object({ type: z.literal("link"), label: z.string().min(1).max(LIMITS.maxLabelLength), urlBinding: z.string().max(80) }).strict(),
    z.object({
      type: z.literal("clock"),
      format: z.enum(["12_hour", "24_hour"]),
      showDate: z.boolean().optional(),
      showSeconds: z.boolean().optional(),
    }).strict(),
    z
      .object({ type: z.literal("metric"), label: z.string().min(1).max(LIMITS.maxLabelLength), valueBinding: z.string().max(80) })
      .strict(),
    z.object({ type: z.literal("progress"), label: z.string().max(LIMITS.maxLabelLength).optional(), valueBinding: z.string().max(80), maxValue: z.number().int().min(1).max(1_000_000), widthDp: z.number().int().min(50).max(240).optional(), heightDp: z.number().int().min(3).max(16).optional() }).strict(),
    z.object({ type: z.literal("list"), source: sourceId, maxItems: z.number().int().min(1).max(LIMITS.maxListItems) }).strict(),
    z.object({ type: z.literal("streak_chart"), source: sourceId }).strict(),
    z.object({ type: z.literal("divider") }).strict(),
    z.object({ type: z.literal("spacer"), sizeDp: z.number().int().min(1).max(64) }).strict(),
    z.object({ type: z.literal("button"), label: z.string().min(1).max(LIMITS.maxLabelLength), action }).strict(),
  ]),
);

export const specSchema: z.ZodType<WidgetSpec> = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(SCHEMA_VERSION)]),
    name: z.string().trim().min(1).max(LIMITS.maxNameLength),
    presentation: z
      .object({
        theme: z.enum(WIDGET_THEMES),
        fontFamily: z.enum(WIDGET_FONT_FAMILIES).optional(),
        palette: paletteSchema.optional(),
        refreshMinutes: z.number().int().min(15).max(1440),
        minWidthDp: z.number().int().min(40).max(600).optional(),
        minHeightDp: z.number().int().min(40).max(600).optional(),
      })
      .strict(),
    dataSources: z.array(z.discriminatedUnion("connector", [
      z.object({ id: sourceId, connector: z.literal("github"), query: z.enum(GITHUB_QUERIES) }).strict(),
      z.object({ id: sourceId, connector: z.literal("website"), query: z.literal("page"), url: z.string().url().max(2048) }).strict(),
    ])).max(LIMITS.maxDataSources),
    root: nodeSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.schemaVersion < 4 && spec.presentation.fontFamily !== undefined) {
      ctx.addIssue({ code: "custom", path: ["presentation", "fontFamily"], message: "fontFamily requires WidgetSpec v4" });
    }
    const containsStreakChart = (node: WidgetNode): boolean => node.type === "streak_chart" ||
      ((node.type === "column" || node.type === "row") && node.children.some(containsStreakChart));
    if (spec.schemaVersion < 5 && containsStreakChart(spec.root)) {
      ctx.addIssue({ code: "custom", path: ["root"], message: "streak_chart requires WidgetSpec v5" });
    }
    if (spec.schemaVersion >= 6 && !spec.presentation.palette) {
      ctx.addIssue({ code: "custom", path: ["presentation", "palette"], message: "palette is required by WidgetSpec v6" });
    }
    if (spec.schemaVersion < 6 && spec.presentation.palette) {
      ctx.addIssue({ code: "custom", path: ["presentation", "palette"], message: "palette tokens require WidgetSpec v6" });
    }
    if (spec.presentation.palette) {
      const palette = spec.presentation.palette;
      const luminance = (hex: string) => {
        const channel = (start: number) => {
          const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
      };
      const contrast = (a: string, b: string) => {
        const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (bright + 0.05) / (dark + 0.05);
      };
      if (contrast(palette.text, palette.background) < 4.5 || contrast(palette.text, palette.surface) < 4.5) {
        ctx.addIssue({ code: "custom", path: ["presentation", "palette"], message: "text color needs at least 4.5:1 contrast against background and surface" });
      }
      if (contrast(palette.muted, palette.background) < 3 || contrast(palette.accent, palette.background) < 3) {
        ctx.addIssue({ code: "custom", path: ["presentation", "palette"], message: "muted and accent colors need at least 3:1 contrast against the background" });
      }
    }
    if (spec.schemaVersion !== 1) return;
    if (spec.dataSources.some((source) => source.connector !== "github")) {
      ctx.addIssue({ code: "custom", path: ["dataSources"], message: "WidgetSpec v1 supports GitHub data sources only" });
    }
    const hasClock = (node: WidgetNode): boolean =>
      node.type === "clock" || ((node.type === "column" || node.type === "row") && node.children.some(hasClock));
    if (hasClock(spec.root)) ctx.addIssue({ code: "custom", path: ["root"], message: "WidgetSpec v1 does not support clock nodes" });
  });

/** `<source>.count` or `<source>.items[<i>].<field>`. */
const BINDING = /^([a-z][a-z0-9_]{0,23})\.(?:count|items\[(\d{1,2})\]\.(title|url|repo|number|author|updatedAt|imageUrl))$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type Binding = { source: string; kind: "count" } | { source: string; kind: "item"; index: number; field: string };

export function parseBinding(binding: string): Binding | null {
  const m = BINDING.exec(binding);
  if (!m) return null;
  return m[2] === undefined ? { source: m[1], kind: "count" } : { source: m[1], kind: "item", index: Number(m[2]), field: m[3] };
}

export type SpecIssue = { path: string; message: string };

/**
 * Checks what a schema cannot: size and depth limits, that every binding names a
 * declared data source, that `open_url` only ever opens a connector-provided URL, and
 * that the target renderer supports every component used. Returns all issues at once
 * so a model can repair them in one pass.
 */
export function checkSpec(spec: WidgetSpec, supportedNodes: ReadonlySet<string> = ALL_NODES): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const sources = new Set<string>();
  spec.dataSources.forEach((ds, i) => {
    if (sources.has(ds.id)) issues.push({ path: `dataSources[${i}].id`, message: `duplicate id "${ds.id}"` });
    sources.add(ds.id);
    if (ds.connector === "website") {
      const url = new URL(ds.url);
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      const ipVersion = isIP(hostname);
      const ipv4 = ipVersion === 4 ? hostname.split(".").map(Number) : [];
      const privateIp = ipVersion === 4
        ? ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224 ||
          (ipv4[0] === 169 && ipv4[1] === 254) ||
          (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
          (ipv4[0] === 192 && (ipv4[1] === 0 || ipv4[1] === 168))
        : ipVersion === 6 && (hostname === "::" || hostname === "::1" || /^(fc|fd|fe[89ab]|ff|::ffff:)/i.test(hostname));
      const localHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
      if (url.protocol !== "https:" || url.username || url.password || url.port || localHost || privateIp) {
        issues.push({ path: `dataSources[${i}].url`, message: "website sources must use public HTTPS URLs without credentials or custom ports" });
      }
    }
  });

  const used = new Set<string>();
  const checkBinding = (raw: string, path: string, opts: { urlOnly?: boolean; imageOnly?: boolean } = {}) => {
    const b = parseBinding(raw);
    if (!b) {
      issues.push({ path, message: `"${raw}" is not a binding; use <source>.count or <source>.items[0].<${ITEM_FIELDS.join("|")}>` });
      return;
    }
    if (!sources.has(b.source)) issues.push({ path, message: `binding uses undeclared data source "${b.source}"` });
    used.add(b.source);
    if (b.kind === "item" && b.index > LIMITS.maxItemIndex) {
      issues.push({ path, message: `item index must be between 0 and ${LIMITS.maxItemIndex}` });
    }
    if (opts.urlOnly && !(b.kind === "item" && b.field === "url")) {
      issues.push({ path, message: "open_url may only open <source>.items[i].url" });
    }
    if (opts.imageOnly) {
      if (!(b.kind === "item" && b.field === "imageUrl")) {
        issues.push({ path, message: "image source must bind to <source>.items[i].imageUrl" });
      } else if (!spec.dataSources.some((source) => source.id === b.source && source.connector === "website")) {
        issues.push({ path, message: "images are only available from website data sources" });
      }
    }
  };
  const checkTemplate = (text: string, path: string) => {
    for (const [, inner] of text.matchAll(PLACEHOLDER)) checkBinding(inner, path);
  };

  let count = 0;
  const visit = (node: WidgetNode, path: string, depth: number) => {
    count += 1;
    if (depth > LIMITS.maxDepth) issues.push({ path, message: `nested deeper than ${LIMITS.maxDepth}` });
    if (!supportedNodes.has(node.type)) issues.push({ path, message: `the renderer does not support "${node.type}"` });
    switch (node.type) {
      case "column":
      case "row":
        node.children.forEach((child, i) => visit(child, `${path}.children[${i}]`, depth + 1));
        break;
      case "text":
        checkTemplate(node.text, `${path}.text`);
        break;
      case "image":
        if (/^asset_[0-9a-f-]{36}$/i.test(node.source)) {
          // User-scoped asset ownership is checked by the API when previewing and saving.
        } else {
          checkBinding(node.source, `${path}.source`, { imageOnly: true });
        }
        break;
      case "link":
        checkBinding(node.urlBinding, `${path}.urlBinding`, { urlOnly: true });
        break;
      case "metric":
        checkBinding(node.valueBinding, `${path}.valueBinding`);
        break;
      case "progress":
        checkBinding(node.valueBinding, `${path}.valueBinding`);
        break;
      case "list":
        if (!sources.has(node.source)) issues.push({ path: `${path}.source`, message: `undeclared data source "${node.source}"` });
        used.add(node.source);
        break;
      case "streak_chart": {
        const source = spec.dataSources.find((candidate) => candidate.id === node.source);
        if (source?.connector !== "github" || source.query !== "contribution_streak") {
          issues.push({ path: `${path}.source`, message: "streak_chart requires a GitHub contribution_streak data source" });
        }
        if (!source) issues.push({ path: `${path}.source`, message: `undeclared data source "${node.source}"` });
        used.add(node.source);
        break;
      }
      case "button":
        checkTemplate(node.label, `${path}.label`);
        if (node.action.type === "open_url") checkBinding(node.action.urlBinding, `${path}.action.urlBinding`, { urlOnly: true });
        break;
    }
  };
  visit(spec.root, "root", 1);

  if (count > LIMITS.maxNodes) issues.push({ path: "root", message: `${count} nodes exceeds the limit of ${LIMITS.maxNodes}` });
  for (const id of sources) if (!used.has(id)) issues.push({ path: "dataSources", message: `data source "${id}" is never used` });
  if (Buffer.byteLength(JSON.stringify(spec)) > LIMITS.maxSpecBytes) {
    issues.push({ path: "", message: `spec is larger than ${LIMITS.maxSpecBytes} bytes` });
  }
  return issues;
}

export const ALL_NODES: ReadonlySet<string> = new Set(COMPONENT_CATALOG.map((component) => component.type));

/**
 * Renderer capability registry: what each native renderer can draw. A spec is checked
 * against the renderer it will be published to, so unsupported components are caught
 * here instead of failing on a phone.
 */
export const RENDERERS = {
  "android-remoteviews-v1": ALL_NODES,
} as const satisfies Record<string, ReadonlySet<string>>;

export type RendererId = keyof typeof RENDERERS;

/** Schema + semantic validation in one call. */
export function validateSpec(
  input: unknown,
  renderer: RendererId = "android-remoteviews-v1",
): { ok: true; spec: WidgetSpec } | { ok: false; issues: SpecIssue[] } {
  const parsed = specSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const issues = checkSpec(parsed.data, RENDERERS[renderer]);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec: parsed.data };
}
