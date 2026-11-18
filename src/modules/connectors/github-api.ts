import { ToolError, type GitHubApi } from "./connector.js";

const API_URL = "https://api.github.com";
const PROFILE_URL = "https://github.com";
const TIMEOUT_MS = 20_000;
const SEARCH_TTL_MS = 120_000;
const CALENDAR_TTL_MS = 600_000;
const PER_PAGE = 10;

export type ContributionCalendarPayload = {
  total: number;
  days: { date: string; count: number; level: number }[];
};

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function githubFetch(url: string, accept: string): Promise<{ status: number; body: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": "WidgetComposer", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new ToolError("GitHub timed out.", "upstream");
    throw new ToolError("Could not reach GitHub.", "upstream");
  }
  const body = await response.text();
  if (response.status === 401) throw new ToolError("GitHub denied the request.", "unauthorized");
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429) {
      throw new ToolError("GitHub rate limit reached. Try again shortly.", "rate_limited");
    }
    throw new ToolError("GitHub refused the request.", "upstream");
  }
  if (response.status >= 400) throw new ToolError(`GitHub returned HTTP ${response.status}.`, "upstream");
  return { status: response.status, body };
}

const countFromTooltip = (text: string): number => {
  if (/no contributions/i.test(text)) return 0;
  const match = text.match(/([\d,]+)\s+contributions?/i);
  return match ? Number(match[1].replace(/,/g, "")) : 0;
};

/** The public profile page renders the contribution graph as tds plus matching tooltips. */
function parseContributionCalendar(html: string): ContributionCalendarPayload {
  const countsById = new Map<string, number>();
  for (const match of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g)) {
    countsById.set(match[1], countFromTooltip(match[2].replace(/<[^>]+>/g, " ")));
  }

  const days: ContributionCalendarPayload["days"] = [];
  for (const match of html.matchAll(/<td\b[^>]*>/g)) {
    const tag = match[0];
    const date = tag.match(/\bdata-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (!date || !id) continue;
    const level = Number(tag.match(/\bdata-level="(\d)"/)?.[1] ?? 0);
    days.push({ date, count: countsById.get(id) ?? 0, level: Math.min(4, Math.max(0, level)) });
  }
  if (!days.length) throw new ToolError("GitHub returned an unreadable contribution graph.", "upstream");
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { total: days.reduce((sum, day) => sum + day.count, 0), days };
}

export function githubPublicApi(): GitHubApi {
  return {
    async searchIssues(qualifier) {
      const query = qualifier;
      return cached(`search:${query}`, SEARCH_TTL_MS, async () => {
        const params = new URLSearchParams({ q: query, sort: "updated", order: "desc", per_page: String(PER_PAGE) });
        const { body } = await githubFetch(`${API_URL}/search/issues?${params}`, "application/vnd.github+json");
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new ToolError("GitHub returned an unreadable search response.", "upstream");
        }
      });
    },

    async contributionCalendar(username) {
      return cached(`calendar:${username}`, CALENDAR_TTL_MS, async () => {
        const { body } = await githubFetch(`${PROFILE_URL}/users/${encodeURIComponent(username)}/contributions`, "text/html");
        return parseContributionCalendar(body);
      });
    },
  };
}
