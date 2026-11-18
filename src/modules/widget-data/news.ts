import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request } from "node:https";

import { HttpError } from "../../lib/errors.js";
import { type SourceData } from "../connectors/github.js";
import { fetchWebsitePage, fetchWidgetImageAsset, type ImageAsset } from "./website.js";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_FEED_BYTES = 2_000_000;
const MAX_STORIES = 20;
const MAX_REDIRECTS = 4;
const MAX_SUMMARY_CHARS = 500;

type SafeAddress = { url: URL; address: string; family: number };
type Downloaded = { kind: "document"; url: URL; body: string; contentType: string } | { kind: "redirect"; url: URL; location: string };

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return !(value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") ||
      value.startsWith("feb") || value.startsWith("ff") || value.startsWith("::ffff:"));
  }
  return false;
}

async function safeAddress(rawUrl: string): Promise<SafeAddress> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new HttpError(422, "INVALID_NEWS_URL", "Use a public HTTPS site or RSS/Atom feed URL."); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hostname ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new HttpError(422, "INVALID_NEWS_URL", "News sources must use public HTTPS URLs without credentials or custom ports.");
  }
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] :
    await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) {
    throw new HttpError(422, "INVALID_NEWS_URL", "That news source is not a public webpage.");
  }
  url.hash = "";
  return { url, address: records[0].address, family: records[0].family };
}

function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function download(url: URL, address: string, family: number): Promise<Downloaded> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request(url, {
      method: "GET",
      headers: {
        "User-Agent": "WidgetComposer/1.0 (+https://widgetcomposer.app; RSS reader)",
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.8",
      },
      timeout: REQUEST_TIMEOUT_MS,
      lookup: pinnedLookup(address, family),
    }, (res) => {
      const status = res.statusCode ?? 500;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.resume();
        if (!location) fail(new HttpError(502, "NEWS_FEED_UNAVAILABLE", "The news source redirected without a destination."));
        else {
          settled = true;
          resolve({ kind: "redirect", url, location });
        }
        return;
      }
      if (status !== 200) {
        res.resume();
        fail(new HttpError(502, "NEWS_FEED_UNAVAILABLE", `The news source returned HTTP ${status}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_FEED_BYTES) {
          fail(new HttpError(502, "NEWS_FEED_TOO_LARGE", "The news feed exceeds the 2 MB size limit."));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ kind: "document", url, body: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "") });
      });
      res.on("error", (error) => fail(error));
    });
    req.on("timeout", () => req.destroy(new Error("news source request timed out")));
    req.on("error", (error) => fail(new HttpError(502, "NEWS_FEED_UNAVAILABLE", `The news source could not be reached (${(error as NodeJS.ErrnoException).code ?? error.name}).`)));
    req.end();
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1].toLowerCase()] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function decodeXml(raw: string): string {
  return raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_entity, code: string) => {
      if (code[0] === "#") {
        const value = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value <= 0x10ffff ? String.fromCodePoint(value) : "";
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[code.toLowerCase()] ?? "";
    })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function tagValue(block: string, names: string[]): string {
  for (const name of names) {
    const safeName = name.replace(":", "\\:");
    const match = new RegExp(`<${safeName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeName}\\s*>`, "i").exec(block);
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function rawTagValue(block: string, names: string[]): string {
  for (const name of names) {
    const safeName = name.replace(":", "\\:");
    const match = new RegExp(`<${safeName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeName}\\s*>`, "i").exec(block);
    if (match) return match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1");
  }
  return "";
}

function safeContentUrl(raw: string, base: URL): string {
  if (!raw || raw.length > 2_048) return "";
  try {
    const url = new URL(raw, base);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") || (isIP(hostname) > 0 && !isPublicAddress(hostname))) return "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

function linkedFeed(html: string, pageUrl: URL): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const values = attributes(match[0]);
    const rels = (values.rel ?? "").toLowerCase().split(/\s+/);
    const type = (values.type ?? "").toLowerCase().split(";")[0].trim();
    if (rels.includes("alternate") && ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"].includes(type)) {
      const url = safeContentUrl(values.href ?? "", pageUrl);
      if (url) return url;
    }
  }
  return null;
}

function storyLink(block: string, base: URL): string {
  for (const match of block.matchAll(/<link\b[^>]*>/gi)) {
    const values = attributes(match[0]);
    const rel = (values.rel ?? "alternate").toLowerCase();
    if (rel === "alternate" || rel === "") {
      const raw = values.href || (match[0].match(/>([\s\S]*?)<\/link\s*>/i)?.[1] ?? "");
      const safe = safeContentUrl(decodeXml(raw), base);
      if (safe) return safe;
    }
  }
  const raw = tagValue(block, ["guid", "id"]);
  return safeContentUrl(raw, base);
}

function storyImage(block: string, base: URL): string | undefined {
  const candidates: string[] = [];
  for (const match of block.matchAll(/<(?:enclosure|media:content|media:thumbnail|itunes:image)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const value = attrs.url ?? attrs.href;
    const type = (attrs.type ?? "").toLowerCase();
    if (value && (!type || type.startsWith("image/"))) candidates.push(value);
  }
  const encodedContent = rawTagValue(block, ["content:encoded", "description", "summary"]);
  const embedded = /<img\b[^>]*(?:src|data-src)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(encodedContent);
  if (embedded) candidates.push(embedded[1] ?? embedded[2]);
  for (const candidate of candidates) {
    const url = safeContentUrl(candidate, base);
    if (url) return url;
  }
  return undefined;
}

function parseFeed(body: string, feedUrl: URL): SourceData | null {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(body)) return null;
  const isAtom = /<feed\b/i.test(body);
  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/i.exec(body)?.[1] ?? body;
  const sourceName = tagValue(channel, ["title"]) || feedUrl.hostname;
  const entries = [...body.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].slice(0, MAX_STORIES);
  const items = entries.flatMap((entry) => {
    const block = entry[2];
    const title = tagValue(block, ["title"]);
    const url = storyLink(block, feedUrl);
    if (!title || !url) return [];
    const rawDate = tagValue(block, isAtom ? ["published", "updated", "pubDate", "dc:date"] : ["pubDate", "published", "updated", "dc:date"]);
    const parsedDate = rawDate ? new Date(rawDate) : null;
    const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : "";
    const summary = tagValue(block, ["summary", "description", "content:encoded", "content"]).slice(0, MAX_SUMMARY_CHARS);
    const author = tagValue(block, ["author><name", "author", "dc:creator", "creator"]);
    const imageUrl = storyImage(block, feedUrl);
    return [{
      title: title.slice(0, 200), url, repo: sourceName.slice(0, 120), number: 0,
      author: author.slice(0, 120), updatedAt: publishedAt, publishedAt,
      summary, sourceName: sourceName.slice(0, 120), ...(imageUrl ? { imageUrl } : {}),
    }];
  });
  return { count: items.length, items };
}

export function linkedPageStories(page: SourceData, publisherUrl: URL): SourceData["items"] {
  const canonical = page.metadata?.canonicalUrl ?? publisherUrl.toString();
  const publisherHost = publisherUrl.hostname.replace(/^www\./i, "");
  const excludedPath = /^\/(?:author|authors|tag|tags|category|categories|sponsored|page|feed|about|contact|privacy|terms|search|account|settings)(?:\/|$)/i;
  return (page.metadata?.links ?? [])
    .filter((link) => {
      if (link.title.trim().length < 25 || !link.url || link.url === canonical) return false;
      try {
        const url = new URL(link.url);
        const host = url.hostname.replace(/^www\./i, "");
        return host === publisherHost && url.pathname !== "/" && !excludedPath.test(url.pathname);
      } catch {
        return false;
      }
    })
    .slice(0, MAX_STORIES)
    .map((link, index) => ({
      title: link.title.slice(0, 200),
      url: link.url,
      repo: publisherUrl.hostname,
      number: index + 1,
      author: "",
      updatedAt: "",
      summary: "",
      publishedAt: "",
      sourceName: publisherUrl.hostname,
      ...(link.imageUrl ? { imageUrl: link.imageUrl } : {}),
    }));
}

type ArticleImageFetcher = (url: string) => Promise<SourceData>;
type WidgetImageFetcher = (url: string) => Promise<ImageAsset | null>;

/** Tries the feed thumbnail first, then image candidates extracted from the story page. */
export async function enrichNewsImages(
  items: SourceData["items"],
  imageIndexes: number[],
  fetchArticle: ArticleImageFetcher = (url) => fetchWebsitePage(url),
  fetchImage: WidgetImageFetcher = fetchWidgetImageAsset,
): Promise<void> {
  const indexes = [...new Set(imageIndexes)].filter((index) => index >= 0 && index < items.length).slice(0, 3);
  await Promise.all(indexes.map(async (index) => {
    const item = items[index];
    if (!item) return;
    const candidates = item.imageUrl ? [item.imageUrl] : [];
    for (const candidate of candidates) {
      const image = await fetchImage(candidate);
      if (!image) continue;
      Object.assign(item, image);
      return;
    }

    let page: SourceData;
    try {
      page = await fetchArticle(item.url);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      console.warn(`[news] article image fallback unavailable (${error.code})`);
      return;
    }
    const fallbacks = [
      ...(page.metadata?.structuredData ?? []).map((entry) => entry.imageUrl),
      ...(page.metadata?.images ?? []).map((image) => image.url),
      ...(page.metadata?.links ?? []).map((link) => link.imageUrl ?? ""),
    ].filter((url, candidateIndex, all) => url && url !== item.imageUrl && all.indexOf(url) === candidateIndex);
    for (const candidate of fallbacks) {
      const image = await fetchImage(candidate);
      if (!image) continue;
      item.imageUrl = candidate;
      Object.assign(item, image);
      return;
    }
  }));
}

export async function fetchNewsFeed(rawUrl: string, options: { imageIndexes?: number[] } = {}): Promise<SourceData> {
  let currentUrl = rawUrl;
  let followedSiteFeed = false;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const safe = await safeAddress(currentUrl);
    const result = await download(safe.url, safe.address, safe.family);
    if (result.kind === "redirect") {
      if (redirect === MAX_REDIRECTS) throw new HttpError(502, "NEWS_FEED_REDIRECT", "The news source redirected too many times.");
      currentUrl = new URL(result.location, result.url).toString();
      continue;
    }
    const feed = parseFeed(result.body, result.url);
    if (feed) {
      await enrichNewsImages(feed.items, options.imageIndexes ?? []);
      return feed;
    }
    const contentType = result.contentType.toLowerCase();
    if (!followedSiteFeed && (/text\/html|application\/xhtml\+xml/.test(contentType) || /<html\b/i.test(result.body))) {
      const discovered = linkedFeed(result.body, result.url);
      if (discovered) {
        currentUrl = discovered;
        followedSiteFeed = true;
        redirect = -1;
        continue;
      }
      // Some publishers omit feed discovery metadata. Fall back to the bounded
      // homepage inventory so the connector still exposes linked article cards.
      const page = await fetchWebsitePage(result.url.toString());
      const stories = linkedPageStories(page, result.url);
      await enrichNewsImages(stories, options.imageIndexes ?? []);
      if (stories.length > 0) return { count: stories.length, items: stories };
      throw new HttpError(422, "NEWS_FEED_NOT_FOUND", "No news feed or linked article headlines could be found on this site.");
    }
    throw new HttpError(422, "NEWS_FEED_INVALID", "The source did not return a readable RSS or Atom feed.");
  }
  throw new HttpError(502, "NEWS_FEED_REDIRECT", "The news source redirected too many times.");
}
