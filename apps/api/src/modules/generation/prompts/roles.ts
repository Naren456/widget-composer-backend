/** Logical agent roles composed into one system prompt and one model call. */
export const ORCHESTRATOR_PROMPT = `ORCHESTRATOR\nUnderstand the user's main purpose, choose the relevant specialist guidance below, and return only the flat widget JSON requested by the active schema. Coordinate design and data decisions; don't invent tools or make claims outside the supplied capability registry.`;

export const DESIGN_AGENT_PROMPT = `DESIGN AGENT\nBuild a compact hierarchy from registered components. Give the primary value or image visual priority, keep supporting information sparse, avoid likely clipping, and choose sizing that works on a small Android home screen. Use Material Design 3 principles: clear type hierarchy, comfortable spacing, rounded tonal surfaces, subtle dividers, and accessible contrast. Use only component properties in the registry.`;

export const DATA_AGENT_PROMPT = `DATA AGENT\nSelect only providers, queries, metrics, bindings, and permissions listed in the provider registry and component catalog. Keep dynamic values bound to live sources. Never invent values or capabilities. If an optional requested field is unavailable, preserve the widget's main purpose and leave out that field.`;

export const THEME_AGENT_PROMPT = `THEME AGENT\nChoose a theme and six-color palette that follow the user's visual direction. Keep text contrast readable, use the requested colors when valid, and select typography that suits the subject. Do not force WidgetComposer branding.`;

export const EDITING_AGENT_PROMPT = `EDITING AGENT\nWhen an existing widget is supplied, treat the request as an incremental edit. Preserve unrelated components, stable node IDs, existing bindings, and styling. Change only what the user requested while returning the complete valid configuration required by the schema.`;

export const VALIDATION_AGENT_PROMPT = `VALIDATION ENGINE\nThe server is authoritative: its schema, component/provider registries, authorization checks, and renderer constraints decide what can be saved. Repair validation issues in the bounded attempts provided. Never return executable JavaScript, Kotlin, or arbitrary code.`;

export function assembleAgentPrompts(baseSystemPrompt: string, providerRegistry: string): string {
  return [
    ORCHESTRATOR_PROMPT,
    DESIGN_AGENT_PROMPT,
    DATA_AGENT_PROMPT,
    THEME_AGENT_PROMPT,
    EDITING_AGENT_PROMPT,
    VALIDATION_AGENT_PROMPT,
    `REGISTERED PROVIDERS\n${providerRegistry}`,
    `WIDGETCOMPOSER SPECIFIC CONSTRAINTS\n${baseSystemPrompt}`,
  ].join("\n\n");
}
