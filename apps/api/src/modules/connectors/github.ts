import { type GITHUB_QUERIES } from "../../spec/widget-spec.js";
import { ToolError, type GitHubApi } from "./connector.js";
import { type ContributionCalendarPayload } from "./github-api.js";

/**
 * The read-only GitHub queries a spec can name, read from GitHub's public API for the
 * username stored on the data source. Responses are normalised into one small shape so
 * specs bind to stable fields, and nothing beyond those fields is stored or passed on.
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
  summary?: string;
  publishedAt?: string;
  sourceName?: string;
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
const MAX_ITEMS = 10;
const MAX_TITLE = 200;

/** Public search qualifiers per query; the username replaces the old `@me` identity. */
const QUALIFIERS: Record<Exclude<GitHubQuery, "contribution_streak">, (username: string) => string> = {
  assigned_issues: (username) => `is:issue is:open archived:false assignee:${username}`,
  open_pull_requests: (username) => `is:pr is:open archived:false author:${username}`,
  review_requests: (username) => `is:pr is:open archived:false review-requested:${username}`,
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

function asSearchResult(value: unknown): SearchResult {
  if (!value || typeof value !== "object") throw new ToolError("GitHub returned an unreadable search response.", "upstream");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.items)) throw new ToolError("GitHub returned an unreadable search response.", "upstream");
  return body as SearchResult;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function runQuery(github: GitHubApi, query: GitHubQuery, username: string): Promise<SourceData> {
  if (query === "contribution_streak") return runContributionQuery(github, username);
  const body = asSearchResult(await github.searchIssues(QUALIFIERS[query](username)));
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

async function runContributionQuery(github: GitHubApi, username: string): Promise<SourceData> {
  const calendar = await github.contributionCalendar(username) as ContributionCalendarPayload;
  if (!Array.isArray(calendar?.days) || !calendar.days.length) {
    throw new ToolError("GitHub returned an unreadable contribution calendar.", "upstream");
  }
  const allDays = calendar.days.flatMap((day) => {
    if (!day || typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return [];
    const count = typeof day.count === "number" ? Math.max(0, day.count) : 0;
    return [{ date: day.date, count, level: Math.min(4, Math.max(0, day.level ?? 0)) }];
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
  const total = typeof calendar.total === "number" ? calendar.total : allDays.reduce((sum, day) => sum + day.count, 0);
  return { count: total, items: [], contributions: { total, currentStreak, longestStreak, days } };
}

/** Representative data for previews before an account is connected. Clearly flagged as sample. */
export function sampleData(query: GitHubQuery): SourceData {
  const titles: Record<Exclude<GitHubQuery, "contribution_streak">, string[]> = {
    assigned_issues: ["Fix crash on launch", "Update onboarding copy", "Investigate slow sync"],
    open_pull_requests: ["Add widget refresh worker", "Bump dependencies", "Improve error states"],
    review_requests: ["Refactor data layer", "Add dark theme", "Cache API responses"],
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
