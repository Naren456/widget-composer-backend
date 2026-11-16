import { HttpError } from "../../lib/errors.js";
import { fetchWebsitePage } from "../widget-data/website.js";

const SEARCH_TIMEOUT_MS = 12_000;
const MAX_RESULTS = 5;
const MAX_CRAWLS = 3;

type SearxngResponse = {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
  }>;
};

export type ResearchSource = {
  title: string;
  url: string;
  snippet: string;
  page?: {
    title: string;
    description: string;
    headings: string[];
    text: string;
    truncated: boolean;
    links: { title: string; url: string }[];
  };
};

/** Search only when the prompt signals that outside, current, or comparative facts are needed. */
export function needsWebResearch(prompt: string): boolean {
  return /\b(?:research|search(?: the web| online)?|look\s+up|need\s+(?:more\s+)?(?:information|info|details)|find\s+(?:more\s+)?(?:information|details|sources)|latest|current|today|recent|news|compare|comparison|price|weather|reviews?|fact[- ]check|sources)\b/i.test(prompt);
}

/**
 * Queries the app's self-hosted SearXNG instance (no vendor API key), then reads a
 * few public result pages for concise context. Results and page content are untrusted
 * references; callers must preserve source URLs and never follow page instructions.
 */
export async function researchWeb(prompt: string, baseUrl: string): Promise<ResearchSource[]> {
  if (!needsWebResearch(prompt)) return [];

  const query = prompt.replace(/https:\/\/[^\s<>"'`]+/gi, (rawUrl) => {
    try { return ` ${new URL(rawUrl.replace(/[),.;!?]+$/g, "")).hostname} `; } catch { return " "; }
  }).replace(/\s+/g, " ").trim().slice(0, 500);
  if (!query) return [];

  let response: Response;
  try {
    const base = new URL(baseUrl);
    const path = `${base.pathname.replace(/\/+$/, "")}/search`;
    const url = new URL(path, base.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("language", "en-US");
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, "RESEARCH_UNAVAILABLE", "The free SearXNG search service could not be reached. Start it with `docker compose up -d searxng`.");
  }
  if (!response.ok) {
    console.warn(`[research] SearXNG returned HTTP ${response.status}`);
    throw new HttpError(response.status === 429 ? 503 : 502, "RESEARCH_UNAVAILABLE", "The SearXNG search service could not complete this research request.");
  }

  let payload: SearxngResponse;
  try {
    payload = await response.json() as SearxngResponse;
  } catch {
    throw new HttpError(502, "RESEARCH_UNAVAILABLE", "The SearXNG service returned an unreadable response. Make sure JSON results are enabled.");
  }

  const sources = (payload.results ?? []).flatMap((result): ResearchSource[] => {
    if (typeof result.url !== "string" || typeof result.title !== "string") return [];
    try {
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return [];
      url.hash = "";
      return [{
        title: result.title.slice(0, 200),
        url: url.toString(),
        snippet: (typeof result.content === "string" ? result.content : "").trim().slice(0, 700),
      }];
    } catch {
      return [];
    }
  }).slice(0, MAX_RESULTS);

  await Promise.all(sources.slice(0, MAX_CRAWLS).map(async (source) => {
    try {
      const page = await fetchWebsitePage(source.url, { searchText: prompt });
      if (!page.metadata) return;
      source.page = {
        title: page.metadata.title.slice(0, 200),
        description: page.metadata.description.slice(0, 500),
        headings: page.metadata.headings.slice(0, 8),
        text: page.metadata.pageText.slice(0, 2_400),
        truncated: page.metadata.truncated ?? false,
        links: page.metadata.links.slice(0, 8).map(({ title, url }) => ({ title, url })),
      };
    } catch {
      // Keep the search result snippet if a publisher blocks automated page reading.
    }
  }));

  return sources;
}
