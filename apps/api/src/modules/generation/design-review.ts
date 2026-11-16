import { LIMITS, type WidgetSpec } from "../../spec/widget-spec.js";
import { COMPONENT_CATALOG, WIDGET_FONT_FAMILIES, WIDGET_THEMES } from "../../spec/component-catalog.js";
import { type LlmProvider } from "./llm.js";

export type DesignReview = {
  score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "summary", "strengths", "improvements"],
  properties: {
    score: { type: "integer", description: "Overall source-level design quality from 0 to 100" },
    summary: { type: "string", description: "One short sentence summarizing the widget design" },
    strengths: { type: "array", items: { type: "string" }, description: "Up to three concrete strengths" },
    improvements: { type: "array", items: { type: "string" }, description: "Up to four actionable issues or improvements; empty when ready" },
  },
} as const;

const REVIEW_SYSTEM = `You are WidgetComposer's widget design reviewer. Review a validated widget specification for quality before a user places it on their Android home screen. Return only the requested JSON.

Assess the design from its structure and text, not from a screenshot: you cannot claim to have seen or rendered pixels. Check one clear primary purpose, compact glanceability, content hierarchy, likely clipping at small widget sizes, excessive density, image usage and accessible labels, useful actions, binding/data coherence, font choice, contrast/theme consistency, and whether the layout can be understood quickly. The actual target can vary by launcher, so phrase fit concerns as likely risks, not certain pixel measurements.

Use these limits and supported nodes:
- Maximum ${LIMITS.maxNodes} nodes and depth ${LIMITS.maxDepth}; the app has small, medium, and large placement options.
- Font families: ${WIDGET_FONT_FAMILIES.join(", ")}; themes: ${WIDGET_THEMES.join(", ")}.
${COMPONENT_CATALOG.map(({ type, description }) => `- ${type}: ${description}`).join("\n")}

Score guidance: 90-100 strong and ready; 75-89 usable with small refinements; 50-74 has meaningful usability or fit issues; below 50 is hard to use. Do not penalize a simple design just for having few components. Be specific, kind, and concise. Mention only issues evidenced by the spec. Return at most 3 strengths and 4 improvements.`;

export async function reviewWidgetDesign(provider: LlmProvider, spec: WidgetSpec): Promise<DesignReview> {
  const conversation = provider.start(REVIEW_SYSTEM, REVIEW_SCHEMA);
  const reply = await conversation.send(`Review this validated widget specification:\n${JSON.stringify(spec)}`);
  if (reply.kind !== "output") throw new Error("The design reviewer could not produce a review.");

  const parsed = JSON.parse(reply.text) as Partial<DesignReview>;
  if (
    !Number.isInteger(parsed.score) || parsed.score! < 0 || parsed.score! > 100 ||
    typeof parsed.summary !== "string" || !Array.isArray(parsed.strengths) || !Array.isArray(parsed.improvements) ||
    !parsed.strengths.every((item) => typeof item === "string") || !parsed.improvements.every((item) => typeof item === "string")
  ) {
    throw new Error("The design reviewer returned an invalid review.");
  }
  return {
    score: parsed.score!,
    summary: parsed.summary.slice(0, 240),
    strengths: parsed.strengths.slice(0, 3).map((item) => item.slice(0, 200)),
    improvements: parsed.improvements.slice(0, 4).map((item) => item.slice(0, 200)),
  };
}
