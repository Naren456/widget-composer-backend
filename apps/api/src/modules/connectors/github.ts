import { type GITHUB_QUERIES } from "../../spec/widget-spec.js";
import { ToolError, type ConnectorClient } from "./composio.js";

/**
 * The read-only GitHub queries a spec can name, run through Composio. Responses are
 * normalised into one small shape so specs bind to stable fields, and nothing GitHub
 * returns beyond those fields is stored or passed on.
 */

export type GitHubQuery = (typeof GITHUB_QUERIES)[number];

export type DataItem = {
  title: string;
  url: string;
  repo: string;
  number: number;
  author: string;
  updatedAt: string;
  imageUrl?: string;
  imageData?: string;
  imageMimeType?: string;
};
export type StructuredWebsiteData = {
  type: string;
  name: string;
  headline: string;
  description: string;
  url: string;
  author: string;
  datePublished: string;
  keywords: string;
  imageUrl: string;
};
export type WebsiteMetadata = {
  title: string;
  description: string;
  canonicalUrl: string;
  logoUrl: string;
  headings: string[];
  paragraphs: string[];
  pageText: string;
  /** True when a very large HTML response was read up to the safe byte limit. */
  truncated?: boolean;
  links: { title: string; url: string; imageUrl?: string }[];
  images: { url: string; alt: string; title: string }[];
  structuredData: StructuredWebsiteData[];
};
export type GitHubContributionDay = { date: string; count: number; level: number };
export type GitHubContributionSummary = { total: number; currentStreak: number; longestStreak: number; days: GitHubContributionDay[] };
export type SourceData = { count: number; items: DataItem[]; metadata?: WebsiteMetadata; contributions?: GitHubContributionSummary };

export const GITHUB_TOOLKIT = "github";
const SEARCH_TOOL = "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS";
const MAX_ITEMS = 10;
const MAX_TITLE = 200;

/** Search qualifiers per query; `@me` is the connected account. */
const QUALIFIERS: Record<GitHubQuery, string> = {
  assigned_issues: "is:issue is:open archived:false assignee:@me",
  open_pull_requests: "is:pr is:open archived:false author:@me",
  review_requests: "is:pr is:open archived:false review-requested:@me",
  contribution_streak: "",
};

type SearchItem = {
  title?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  number?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown } | null;
};
type SearchResult = { total_count?: unknown; items: SearchItem[] };

/** Composio may wrap the GitHub response (e.g. under `data`), so look a few levels down for it. */
function findSearch(value: unknown, depth = 0): SearchResult | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.items)) return obj as SearchResult;
  for (const child of Object.values(obj)) {
    const found = findSearch(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function runQuery(client: ConnectorClient, userId: string, query: GitHubQuery): Promise<SourceData> {
  if (query === "contribution_streak") return runContributionQuery(client, userId);
  const data = await client.execute(userId, SEARCH_TOOL, {
    q: QUALIFIERS[query],
    sort: "updated",
    order: "desc",
    per_page: MAX_ITEMS,
    response_detail: "full",
  });
  const body = findSearch(data) ?? { total_count: 0, items: [] };
  const items = body.items.slice(0, MAX_ITEMS).map((item) => {
    const url = str(item.html_url);
    return {
      title: str(item.title).slice(0, MAX_TITLE),
      // Only github.com links are passed through; an open_url action opens exactly these.
      url: url.startsWith("https://github.com/") ? url : "https://github.com/",
      repo: str(item.repository_url).replace("https://api.github.com/repos/", ""),
      number: typeof item.number === "number" ? item.number : 0,
      author: str(item.user?.login),
      updatedAt: str(item.updated_at),
    };
  });
  return { count: typeof body.total_count === "number" ? body.total_count : items.length, items };
}

function findContributionCalendar(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.weeks) && typeof obj.totalContributions === "number") return obj;
  for (const child of Object.values(obj)) {
    const found = findContributionCalendar(child, depth + 1);
    if (found) return found;
  }
  return null;
}

async function runContributionQuery(client: ConnectorClient, userId: string): Promise<SourceData> {
  if (!client.githubContributionCalendar) {
    throw new ToolError("GitHub contribution calendars require a Composio project key with proxy_execute access.", "upstream");
  }
  const response = await client.githubContributionCalendar(userId);
  const calendar = findContributionCalendar(response);
  if (!calendar) throw new ToolError("GitHub returned an unreadable contribution calendar.", "upstream");
  const allDays = (calendar.weeks as unknown[]).flatMap((week) => {
    if (!week || typeof week !== "object") return [];
    const days = (week as Record<string, unknown>).contributionDays;
    if (!Array.isArray(days)) return [];
    return days.flatMap((day) => {
      if (!day || typeof day !== "object") return [];
      const row = day as Record<string, unknown>;
      if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return [];
      const count = typeof row.contributionCount === "number" ? Math.max(0, row.contributionCount) : 0;
      const level = typeof row.contributionLevel === "string"
        ? ({ NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 } as Record<string, number>)[row.contributionLevel] ?? 0
        : Math.min(4, Math.ceil(count / 3));
      return [{ date: row.date, count, level }];
    });
  }).sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(allDays.map((day) => [day.date, day]));
  const end = new Date();
  const days: GitHubContributionDay[] = Array.from({ length: 28 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - 27 + index);
    const key = date.toISOString().slice(0, 10);
    return byDate.get(key) ?? { date: key, count: 0, level: 0 };
  });
  let longestStreak = 0;
  let activeStreak = 0;
  for (const day of allDays) {
    activeStreak = day.count > 0 ? activeStreak + 1 : 0;
    longestStreak = Math.max(longestStreak, activeStreak);
  }
  let currentStreak = 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let cursor = allDays.length - 1;
  if (allDays[cursor]?.date === today && allDays[cursor]?.count === 0) cursor -= 1;
  if (allDays[cursor]?.date === today || allDays[cursor]?.date === yesterday) {
    while (cursor >= 0 && allDays[cursor].count > 0) { currentStreak += 1; cursor -= 1; }
  }
  const total = typeof calendar.totalContributions === "number" ? calendar.totalContributions : allDays.reduce((sum, day) => sum + day.count, 0);
  return { count: total, items: [], contributions: { total, currentStreak, longestStreak, days } };
}

/** Representative data for previews before an account is connected. Clearly flagged as sample. */
export function sampleData(query: GitHubQuery): SourceData {
  const titles: Record<GitHubQuery, string[]> = {
    assigned_issues: ["Fix crash on launch", "Update onboarding copy", "Investigate slow sync"],
    open_pull_requests: ["Add widget refresh worker", "Bump dependencies", "Improve error states"],
    review_requests: ["Refactor data layer", "Add dark theme", "Cache API responses"],
    contribution_streak: [],
  };
  if (query === "contribution_streak") {
    const today = new Date();
    const days = Array.from({ length: 28 }, (_, index) => {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - 27 + index);
      const count = index >= 21 && index <= 25 ? 2 + (index % 3) : index === 27 ? 1 : index % 5 === 0 ? 1 : 0;
      return { date: date.toISOString().slice(0, 10), count, level: count ? Math.min(4, Math.ceil(count / 2)) : 0 };
    });
    return { count: 42, items: [], contributions: { total: 42, currentStreak: 3, longestStreak: 12, days } };
  }
  return {
    count: titles[query].length,
    items: titles[query].map((title, i) => ({
      title,
      url: "https://github.com/",
      repo: "example/repo",
      number: 100 + i,
      author: "octocat",
      updatedAt: new Date(0).toISOString(),
    })),
  };
}
