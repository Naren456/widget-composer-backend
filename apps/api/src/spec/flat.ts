import {
  type AllowedAction,
  GITHUB_QUERIES,
  DEVICE_METRICS,
  NEWS_QUERIES,
  WEBSITE_QUERIES,
  ITEM_FIELDS,
  SCHEMA_VERSION,
  type SpecIssue,
  type WidgetNode,
  type WidgetSpec,
} from "./widget-spec.js";
import { DEFAULT_WIDGET_PALETTES, WIDGET_FONT_FAMILIES, WIDGET_THEMES, type WidgetPalette } from "./component-catalog.js";

/**
 * The shape the model writes: a flat node list linked by id.
 *
 * Structured outputs cannot express a recursive schema, so the model returns nodes side
 * by side with `children` as id references, and `toTree` rebuilds the WidgetSpec tree.
 * Length and range limits are also absent here (structured outputs reject them); the
 * full spec validator enforces them after conversion.
 */

type FlatNode = { id: string } & (
  | { type: "column" | "row"; gap?: number; surface?: boolean; radiusDp?: number; paddingDp?: number; children: string[] }
  | { type: "text"; text: string; style?: "title" | "body" | "caption"; fontSizeDp?: number; weight?: "normal" | "medium" | "bold"; colorToken?: "text" | "muted" | "accent" }
  | { type: "image"; source: string; alt?: string; imagePrompt?: string; widthDp?: number; heightDp?: number; fit?: "cover" | "contain"; radiusDp?: number }
  | { type: "link"; label: string; urlBinding: string }
  | { type: "clock"; format: "12_hour" | "24_hour"; showDate?: boolean; showSeconds?: boolean }
  | { type: "metric"; label: string; valueBinding: string }
  | { type: "progress"; label?: string; valueBinding: string; maxValue: number; widthDp?: number; heightDp?: number }
  | { type: "device_info"; metric: (typeof DEVICE_METRICS)[number]; label?: string; display?: "text" | "metric" | "progress" }
  | { type: "list"; source: string; maxItems: number }
  | { type: "streak_chart"; source: string }
  | { type: "divider" }
  | { type: "spacer"; sizeDp: number }
  | { type: "button"; label: string; action: AllowedAction }
);

export type FlatSpec = {
  /** Set when the request needs data or features the platform does not have. */
  unsupported: string | null;
  name: string;
  theme: WidgetSpec["presentation"]["theme"];
  fontFamily: NonNullable<WidgetSpec["presentation"]["fontFamily"]>;
  palette: WidgetPalette;
  refreshMinutes: number;
  dataSources: WidgetSpec["dataSources"];
  rootId: string;
  nodes: FlatNode[];
};

const obj = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const str = { type: "string" };
const int = { type: "integer" };
const nodeId = { type: "string", description: "Unique node id, e.g. n1" };

/** JSON Schema for `output_config.format`. */
export const flatSpecJsonSchema = obj(["unsupported", "name", "theme", "fontFamily", "palette", "refreshMinutes", "dataSources", "rootId", "nodes"], {
  unsupported: {
    anyOf: [{ type: "string" }, { type: "null" }],
    description: "null, or one sentence saying what in the request cannot be built",
  },
  name: { type: "string", description: "Short widget name, at most 40 characters" },
  theme: { enum: [...WIDGET_THEMES] },
  fontFamily: { enum: [...WIDGET_FONT_FAMILIES], description: "System font family; use sans for most compact widgets, serif for editorial styles, monospace for clocks or numeric dashboards" },
  palette: obj(["background", "surface", "text", "muted", "accent", "border"], {
    background: { type: "string", description: "Hex color, e.g. #17202A" }, surface: { type: "string" },
    text: { type: "string" }, muted: { type: "string" }, accent: { type: "string" }, border: { type: "string" },
  }),
  refreshMinutes: { type: "integer", description: "Preferred refresh interval, 15-1440" },
  dataSources: {
    type: "array",
    description: "At most 3. Each must be used by at least one node.",
    items: {
      anyOf: [
        obj(["id", "connector", "query"], {
          id: { type: "string", description: "Lowercase id used in bindings, e.g. prs" },
          connector: { const: "github" },
          query: { enum: [...GITHUB_QUERIES] },
        }),
        obj(["id", "connector", "query", "url"], {
          id: { type: "string", description: "Lowercase id used in bindings, e.g. page" },
          connector: { const: "website" },
          query: { enum: [...WEBSITE_QUERIES] },
          url: { type: "string", description: "A public HTTPS page URL supplied by the user or copied exactly from web research results" },
        }),
        obj(["id", "connector", "query", "url"], {
          id: { type: "string", description: "Lowercase id used in bindings, e.g. news" },
          connector: { const: "news" },
          query: { enum: [...NEWS_QUERIES] },
          url: { type: "string", description: "A public HTTPS site or RSS/Atom feed URL supplied by the user or copied exactly from web research results. The server discovers a linked feed when given a site URL." },
        }),
      ],
    },
  },
  rootId: { type: "string", description: "Id of the root node, normally a column" },
  nodes: {
    type: "array",
    description: "Every node exactly once; containers reference children by id.",
    items: {
      anyOf: [
        obj(["id", "type", "children"], {
          id: nodeId,
          type: { enum: ["column", "row"] },
          gap: int,
          surface: { type: "boolean", description: "Draw a padded card using the palette surface color" },
          radiusDp: int,
          paddingDp: int,
          children: { type: "array", items: str },
        }),
        obj(["id", "type", "text"], {
          id: nodeId,
          type: { const: "text" },
          text: { type: "string", description: "At most 120 characters; may contain {{binding}} placeholders" },
          style: { enum: ["title", "body", "caption"] },
          fontSizeDp: { type: "integer", description: "10-32 dp; keep compact for home-screen readability" },
          weight: { enum: ["normal", "medium", "bold"] },
          colorToken: { enum: ["text", "muted", "accent"] },
        }),
        obj(["id", "type", "source"], {
          id: nodeId,
          type: { const: "image" },
          source: { type: "string", description: "Plain website image binding such as site.items[0].imageUrl (no {{ }} wrapper) or attached_image when using the user's uploaded image as content" },
          alt: { type: "string", description: "Short accessible description" },
          imagePrompt: { type: "string", description: "Optional description when the image is a user-uploaded asset; keep it brief and descriptive" },
          widthDp: { type: "integer", description: "24-240 dp; use 110-180 for a compact hero image" },
          heightDp: { type: "integer", description: "24-240 dp; use 60-120 for a compact hero image" },
          fit: { enum: ["cover", "contain"] },
          radiusDp: { type: "integer", description: "0-24 dp corner radius" },
        }),
        obj(["id", "type", "label", "urlBinding"], {
          id: nodeId,
          type: { const: "link" },
          label: { type: "string", description: "Short visible label for a clickable link" },
          urlBinding: { type: "string", description: "<source>.items[i].url" },
        }),
        obj(["id", "type", "format"], {
          id: nodeId,
          type: { const: "clock" },
          format: { enum: ["12_hour", "24_hour"] },
          showDate: { type: "boolean" },
          showSeconds: { type: "boolean" },
        }),
        obj(["id", "type", "label", "valueBinding"], {
          id: nodeId,
          type: { const: "metric" },
          label: str,
          valueBinding: { type: "string", description: "<source>.count or <source>.items[i].<field>" },
        }),
        obj(["id", "type", "valueBinding", "maxValue"], {
          id: nodeId,
          type: { const: "progress" },
          label: { type: "string" },
          valueBinding: { type: "string", description: "Numeric binding such as source.count" },
          maxValue: { type: "integer", description: "Full scale, 1-1000000" },
          widthDp: { type: "integer" },
          heightDp: { type: "integer" },
        }),
        obj(["id", "type", "metric"], {
          id: nodeId,
          type: { const: "device_info" },
          metric: { enum: [...DEVICE_METRICS] },
          label: { type: "string", description: "Short display label" },
          display: { enum: ["text", "metric", "progress"] },
        }),
        obj(["id", "type", "source", "maxItems"], {
          id: nodeId,
          type: { const: "list" },
          source: { type: "string", description: "A data source id" },
          maxItems: { type: "integer", description: "1-5" },
        }),
        obj(["id", "type", "source"], {
          id: nodeId,
          type: { const: "streak_chart" },
          source: { type: "string", description: "GitHub contribution_streak data source id" },
        }),
        obj(["id", "type"], { id: nodeId, type: { const: "divider" } }),
        obj(["id", "type", "sizeDp"], { id: nodeId, type: { const: "spacer" }, sizeDp: int }),
        obj(["id", "type", "label", "action"], {
          id: nodeId,
          type: { const: "button" },
          label: str,
          action: {
            anyOf: [
              obj(["type", "urlBinding"], {
                type: { const: "open_url" },
                urlBinding: { type: "string", description: "<source>.items[i].url" },
              }),
              obj(["type", "screen"], { type: { const: "open_app" }, screen: { const: "widget_details" } }),
              obj(["type"], { type: { const: "refresh" } }),
              obj(["type"], { type: { const: "lock_screen" } }),
            ],
          },
        }),
      ],
    },
  },
});

/** Short description of the binding grammar, for prompts. */
export const BINDING_HELP = `<source>.count, or <source>.items[i].<field> with i from 0 to 19 and field one of ${ITEM_FIELDS.join(", ")}`;

/**
 * Rebuilds the tree. Rejects duplicate ids, missing references, cycles and nodes used
 * twice. Detached nodes are discarded because they cannot affect the rendered widget.
 */
export function toTree(flat: FlatSpec): { ok: true; spec: WidgetSpec } | { ok: false; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const byId = new Map<string, FlatNode>();
  for (const node of flat.nodes) {
    if (byId.has(node.id)) issues.push({ path: `nodes.${node.id}`, message: "duplicate node id" });
    byId.set(node.id, node);
  }
  if (!byId.has(flat.rootId)) issues.push({ path: "rootId", message: `no node with id "${flat.rootId}"` });
  if (issues.length > 0) return { ok: false, issues };

  const placed = new Set<string>();
  const build = (id: string, trail: string[]): WidgetNode | null => {
    const node = byId.get(id);
    if (!node) {
      issues.push({ path: `nodes.${trail.at(-1) ?? "root"}.children`, message: `references missing node "${id}"` });
      return null;
    }
    if (trail.includes(id)) {
      issues.push({ path: `nodes.${id}`, message: "node contains itself" });
      return null;
    }
    if (placed.has(id)) {
      issues.push({ path: `nodes.${id}`, message: "node is used in more than one place" });
      return null;
    }
    placed.add(id);
    const { id: _id, ...rest } = node;
    if (rest.type === "column" || rest.type === "row") {
      const children = rest.children.map((c) => build(c, [...trail, id])).filter((c): c is WidgetNode => c !== null);
      return { ...rest, children };
    }
    return rest as WidgetNode;
  };

  const root = build(flat.rootId, []);
  if (issues.length > 0 || !root) return { ok: false, issues };

  return {
    ok: true,
    spec: {
      schemaVersion: SCHEMA_VERSION,
      name: flat.name,
      presentation: { theme: flat.theme, fontFamily: flat.fontFamily, palette: flat.palette, refreshMinutes: flat.refreshMinutes },
      dataSources: flat.dataSources,
      root,
    },
  };
}

/** The inverse, so an edit can show the model the current widget in its own format. */
export function toFlat(spec: WidgetSpec): FlatSpec {
  const nodes: FlatNode[] = [];
  let next = 0;
  const walk = (node: WidgetNode): string => {
    const id = `n${++next}`;
    if (node.type === "column" || node.type === "row") {
      const flat = { id, ...node, children: [] as string[] };
      nodes.push(flat);
      flat.children = node.children.map(walk);
    } else {
      nodes.push({ id, ...node } as FlatNode);
    }
    return id;
  };
  const rootId = walk(spec.root);
  return {
    unsupported: null,
    name: spec.name,
    theme: spec.presentation.theme,
    fontFamily: spec.presentation.fontFamily ?? "sans",
    palette: spec.presentation.palette ?? DEFAULT_WIDGET_PALETTES[spec.presentation.theme === "light" ? "light" : "dark"],
    refreshMinutes: spec.presentation.refreshMinutes,
    dataSources: spec.dataSources,
    rootId,
    nodes,
  };
}
