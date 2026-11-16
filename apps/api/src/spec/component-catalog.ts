/**
 * The supported widget DSL registry. Generation prompts, validation and capability
 * discovery all read this list so the agent cannot quietly gain an unrenderable node.
 */
export const COMPONENT_CATALOG = [
  { type: "column", description: "Vertical container; children are drawn top to bottom. Can draw a padded rounded card using the palette surface color.", properties: ["gap", "surface", "radiusDp", "paddingDp", "children"] },
  { type: "row", description: "Horizontal container; children are drawn left to right. Can draw a padded rounded card using the palette surface color.", properties: ["gap", "surface", "radiusDp", "paddingDp", "children"] },
  { type: "text", description: "Static or data-bound text with hierarchy, explicit size, weight, and palette color token.", properties: ["text", "style", "fontSizeDp", "weight", "colorToken"] },
  { type: "image", description: "Website image or explicitly attached image asset, with safe size, crop mode, and rounded corners. Use widthDp/heightDp for a prominent hero image.", properties: ["source", "alt", "widthDp", "heightDp", "fit", "radiusDp"] },
  { type: "link", description: "Short clickable label that opens a connector-provided HTTPS URL binding.", properties: ["label", "urlBinding"] },
  { type: "clock", description: "Device-local time with 12_hour or 24_hour format and optional date and seconds.", properties: ["format", "showDate", "showSeconds"] },
  { type: "metric", description: "One large value from a valid binding with a short label.", properties: ["label", "valueBinding"] },
  { type: "progress", description: "Compact labeled progress bar for a numeric binding such as completion count; maxValue defines the full scale.", properties: ["label", "valueBinding", "maxValue", "widthDp", "heightDp"] },
  { type: "list", description: "Compact list of one to five connector items; rows show title and repo/author metadata.", properties: ["source", "maxItems"] },
  { type: "streak_chart", description: "Compact 28-day GitHub contribution heatmap with current streak and past-year best streak summaries. Requires a GitHub contribution_streak data source.", properties: ["source"] },
  { type: "divider", description: "Thin horizontal separator.", properties: [] },
  { type: "spacer", description: "Fixed gap in dp from 1-64.", properties: ["sizeDp"] },
  { type: "button", description: "Compact action button; actions are restricted to open_url, open_app or refresh.", properties: ["label", "action"] },
] as const;

export const WIDGET_SIZES = ["small", "medium", "large"] as const;
export const WIDGET_ACTIONS = ["open_url", "open_app", "refresh"] as const;
export const WIDGET_THEMES = ["light", "dark", "system"] as const;
export const WIDGET_FONT_FAMILIES = ["sans", "serif", "monospace"] as const;

export type WidgetPalette = { background: string; surface: string; text: string; muted: string; accent: string; border: string };
export const DEFAULT_WIDGET_PALETTES: Record<"light" | "dark", WidgetPalette> = {
  light: { background: "#F7F4EF", surface: "#FFFFFF", text: "#242321", muted: "#6D6963", accent: "#9B4F31", border: "#E6E0D8" },
  dark: { background: "#17191D", surface: "#23262C", text: "#F3F0EB", muted: "#B2B0AA", accent: "#E6A86A", border: "#383C43" },
};
