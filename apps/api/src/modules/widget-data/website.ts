import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request } from "node:https";

import { HttpError } from "../../lib/errors.js";
import { type SourceData, type StructuredWebsiteData } from "../connectors/github.js";

const MAX_HTML_BYTES = 8_000_000;
const MAX_PAGE_TEXT_CHARS = 24_000;
const PAGE_TEXT_CHUNK_CHARS = 1_600;
const MAX_PAGE_TEXT_CHUNKS = Math.ceil(MAX_PAGE_TEXT_CHARS / PAGE_TEXT_CHUNK_CHARS);
const MAX_IMAGE_BYTES = 512_000;
const MAX_ITEMS = 20;
const MAX_LINKS = 100;
const MAX_IMAGES = 80;
const MAX_HEADINGS = 80;
const MAX_PARAGRAPHS = 160;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8_000;

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff") || normalized.startsWith("::ffff:")
    );
  }
  return false;
}

async function checkedUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, "INVALID_WEBSITE_URL", "Use a public HTTPS webpage URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    !hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
  ) {
    throw new HttpError(422, "INVALID_WEBSITE_URL", "Only public HTTPS webpages on the default port are supported.");
  }

  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0 || records.some((record) => !isPublicAddress(record.address))) {
    throw new HttpError(422, "INVALID_WEBSITE_URL", "That address is not a public webpage.");
  }
  url.hash = "";
  return { url, address: records[0].address, family: records[0].family };
}

type DownloadResult = { html: string; truncated?: boolean } | { redirect: string };

function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function downloadHtml(url: URL, address: string, family: number): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishHtml = (chunks: Buffer[], truncated: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ html: Buffer.concat(chunks).toString("utf8"), ...(truncated ? { truncated: true } : {}) });
    };
    const req = request(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
      },
      timeout: REQUEST_TIMEOUT_MS,
      lookup: pinnedLookup(address, family),
    }, (res) => {
      const status = res.statusCode ?? 500;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.resume();
        if (location) resolve({ redirect: location });
        else reject(new HttpError(502, "WEBSITE_REDIRECT", "The webpage redirected without a destination."));
        return;
      }
      if (status !== 200) {
        res.resume();
        if (status === 401 || status === 403 || status === 429) {
          reject(new HttpError(502, "WEBSITE_BLOCKED", "This site blocks automated page access. Try a public article URL instead."));
        } else {
          reject(new HttpError(502, "WEBSITE_UNAVAILABLE", `The webpage returned HTTP ${status}.`));
        }
        return;
      }
      const contentType = res.headers["content-type"] ?? "";
      if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
        res.resume();
        reject(new HttpError(422, "WEBSITE_NOT_HTML", "That URL does not serve a readable webpage."));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        const remaining = MAX_HTML_BYTES - bytes;
        if (chunk.length > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          finishHtml(chunks, true);
          res.destroy();
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      res.on("end", () => finishHtml(chunks, false));
      res.on("error", (error) => { if (!settled) reject(error); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => {
      if (settled) return;
      const code = (error as NodeJS.ErrnoException).code ?? error.name;
      console.warn(`[website] request to ${url.hostname} failed (${code})`);
      reject(new HttpError(502, "WEBSITE_UNAVAILABLE", "The API server could not reach this webpage."));
    });
    req.end();
  });
}

export type ImageAsset = { imageData: string; imageMimeType: string };
type ImageDownload = { asset: ImageAsset } | { redirect: string } | { asset: null };

function downloadImage(url: URL, address: string, family: number): Promise<ImageDownload> {
  return new Promise((resolve) => {
    const req = request(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "image/png,image/jpeg,image/webp,image/gif,image/x-icon;q=0.8,*/*;q=0.5",
      },
      timeout: REQUEST_TIMEOUT_MS,
      lookup: pinnedLookup(address, family),
    }, (res) => {
      const status = res.statusCode ?? 500;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.resume();
        resolve(location ? { redirect: location } : { asset: null });
        return;
      }
      const mimeType = String(res.headers["content-type"] ?? "").split(";")[0].toLowerCase();
      if (status !== 200 || !/^image\/(?:png|jpeg|webp|gif)$/.test(mimeType) ||
        Number(res.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES) {
        res.resume();
        resolve({ asset: null });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) {
          res.destroy();
          resolve({ asset: null });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        asset: {
          imageData: Buffer.concat(chunks).toString("base64"),
          imageMimeType: mimeType,
        },
      }));
      res.on("error", () => resolve({ asset: null }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ asset: null }));
    req.end();
  });
}

async function fetchImageAsset(rawUrl: string): Promise<ImageAsset | null> {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    try {
      const { url, address, family } = await checkedUrl(currentUrl);
      const result = await downloadImage(url, address, family);
      if ("asset" in result) return result.asset;
      if (redirect === MAX_REDIRECTS) return null;
      currentUrl = new URL(result.redirect, url).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Fetches a safe, bounded image for widget data from a public HTTPS URL. */
export function fetchWidgetImageAsset(rawUrl: string): Promise<ImageAsset | null> {
  return fetchImageAsset(rawUrl);
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const numeric = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(Math.min(numeric, 0x10ffff)) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[code.toLowerCase()] ?? "";
  });
}

function readable(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 200);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function safePageLink(raw: string, base: URL): string {
  try {
    const link = new URL(raw, base);
    const host = link.hostname.toLowerCase().replace(/\.$/, "");
    if (link.protocol !== "https:" || link.username || link.password || link.port ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      (isIP(host) > 0 && !isPublicAddress(host))) return "";
    link.hash = "";
    return link.toString();
  } catch {
    return "";
  }
}

function meta(html: string, names: string[]): string {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const values = attrs(tag[0]);
    const name = (values.property ?? values.name ?? values.itemprop ?? "").toLowerCase();
    if (names.includes(name) && values.content) return values.content;
  }
  return "";
}

function structuredEntries(html: string, baseUrl: URL): StructuredWebsiteData[] {
  const entries: StructuredWebsiteData[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || entries.length >= 30 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const object = value as Record<string, unknown>;
    if (object["@graph"]) visit(object["@graph"], depth + 1);
    const authorValue = object.author;
    const author = typeof authorValue === "string"
      ? authorValue
      : authorValue && typeof authorValue === "object"
        ? String((authorValue as Record<string, unknown>).name ?? "")
        : "";
    const text = (key: string) => typeof object[key] === "string" ? (object[key] as string).slice(0, 500) : "";
    const type = typeof object["@type"] === "string" ? object["@type"] as string : "";
    const imageValue = Array.isArray(object.image) ? object.image[0] : object.image;
    const rawImageUrl = typeof imageValue === "string"
      ? imageValue
      : imageValue && typeof imageValue === "object"
        ? String((imageValue as Record<string, unknown>).url ?? (imageValue as Record<string, unknown>).contentUrl ?? "")
        : "";
    if (type || object.headline || object.name) {
      const rawUrl = text("url");
      entries.push({
        type: type.slice(0, 100),
        name: text("name"),
        headline: text("headline"),
        description: text("description"),
        url: rawUrl ? safePageLink(rawUrl, baseUrl) : "",
        author: author.slice(0, 200),
        datePublished: text("datePublished"),
        keywords: Array.isArray(object.keywords) ? object.keywords.map(String).join(", ").slice(0, 500) : text("keywords"),
        imageUrl: rawImageUrl ? safePageLink(rawImageUrl, baseUrl) : "",
      });
    }
    for (const [key, child] of Object.entries(object)) {
      if (key !== "@graph" && child && typeof child === "object") visit(child, depth + 1);
    }
  };
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(script[1])); } catch { /* Ignore malformed page metadata. */ }
  }
  return entries;
}

function relevantPageText(rawText: string, query = ""): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < rawText.length; offset += PAGE_TEXT_CHUNK_CHARS) {
    const chunk = rawText.slice(offset, offset + PAGE_TEXT_CHUNK_CHARS).trim();
    if (chunk) chunks.push(chunk);
  }
  if (chunks.length <= MAX_PAGE_TEXT_CHUNKS) return chunks.join(" ").slice(0, MAX_PAGE_TEXT_CHARS);

  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  const selected = chunks.map((text, index) => ({
    text,
    index,
    score: terms.reduce((score, term) => score + (text.toLowerCase().includes(term) ? 1 : 0), 0),
  }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_PAGE_TEXT_CHUNKS)
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text);
  return selected.join(" ").slice(0, MAX_PAGE_TEXT_CHARS);
}

export function extractWebsiteHtml(html: string, url: URL, query = "", truncated = false): SourceData {
  const content = html.replace(/<!--[\s\S]*?-->|<(script|style|svg|noscript|template|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const title = readable(content.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? meta(html, ["og:title", "twitter:title"])) || url.hostname;
  const description = readable(meta(html, ["description", "og:description", "twitter:description"]));
  const headings = [...content.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/gi)]
    .map((match) => readable(match[1]))
    .filter((heading, index, all) => heading.length > 0 && all.indexOf(heading) === index)
    .slice(0, MAX_HEADINGS);
  const paragraphs = [...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map((match) => readable(match[1]))
    .filter((text, index, all) => text.length > 24 && all.indexOf(text) === index)
    .slice(0, MAX_PARAGRAPHS);
  let textLength = 0;
  const pageParagraphs = paragraphs.filter((paragraph) => {
    if (textLength >= MAX_PAGE_TEXT_CHARS) return false;
    const remaining = MAX_PAGE_TEXT_CHARS - textLength;
    textLength += Math.min(paragraph.length, remaining);
    return true;
  }).map((paragraph) => paragraph.slice(0, MAX_PAGE_TEXT_CHARS));
  const rawPageText = decodeHtml(content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  const pageText = relevantPageText(rawPageText, query);
  const links = [...content.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)]
    .map((match) => {
      const tag = match[0].slice(0, match[0].indexOf(">") + 1);
      const href = attrs(tag).href;
      const hrefUrl = href ? safePageLink(href, url) : "";
      const linkTitle = readable(match[1]);
      const imageTag = match[1].match(/<img\b[^>]*>/i)?.[0];
      const imageAttrs = imageTag ? attrs(imageTag) : {};
      const imageUrl = safePageLink(imageAttrs["data-src"] ?? imageAttrs.src ?? imageAttrs["data-original"] ?? "", url);
      return hrefUrl && linkTitle ? { title: linkTitle, url: hrefUrl, ...(imageUrl ? { imageUrl } : {}) } : null;
    })
    .filter((link): link is { title: string; url: string; imageUrl?: string } => link !== null)
    .filter((link, index, all) => all.findIndex((item) => item.url === link.url) === index)
    .slice(0, MAX_LINKS);
  const htmlImages = [...content.matchAll(/<img\b[^>]*>/gi)]
    .map((match) => {
      const values = attrs(match[0]);
      const raw = values["data-src"] ?? values.src ?? values["data-original"] ?? values.srcset?.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
      const imageUrl = safePageLink(raw, url);
      if (!imageUrl) return null;
      return { url: imageUrl, alt: (values.alt ?? "").slice(0, 200), title: (values.title ?? "").slice(0, 200) };
    })
    .filter((image): image is { url: string; alt: string; title: string } => image !== null)
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, MAX_IMAGES);
  const structuredData = structuredEntries(html, url);
  const images = [...htmlImages, ...structuredData
    .filter((entry) => entry.imageUrl)
    .map((entry) => ({ url: entry.imageUrl, alt: entry.headline || entry.name, title: entry.type }))]
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, MAX_IMAGES);
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => attrs(match[0]))
    .find((values) => values.rel?.toLowerCase().split(/\s+/).includes("canonical"));
  const iconTags = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => attrs(match[0]))
    .filter((values) => /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(values.rel ?? ""));
  const imageCandidates = [
    meta(html, ["og:image", "twitter:image"]),
    ...iconTags.map((values) => values.href),
  ];
  const logoCandidate = imageCandidates.find((href) =>
    Boolean(href) && !/\.(?:ico|svg)(?:$|[?#])/i.test(href),
  ) ?? "";
  const canonicalUrl = canonicalTag?.href ? safePageLink(canonicalTag.href, url) || url.toString() : url.toString();
  const logoUrl = logoCandidate ? safePageLink(logoCandidate, url) : "";
  const metadata = { title, description, canonicalUrl, logoUrl, headings, paragraphs: pageParagraphs, pageText, links, images, structuredData, truncated };
  const items = [
    { title, url: canonicalUrl, repo: url.hostname, number: 0, author: description, updatedAt: "", ...(logoUrl ? { imageUrl: logoUrl } : {}) },
    ...headings.slice(0, 3).map((heading, index) => ({ title: heading, url: canonicalUrl, repo: url.hostname, number: index + 1, author: description, updatedAt: "" })),
    ...structuredData.filter((entry) => {
      if (entry.headline) return true;
      if (/\b(?:website|webpage|organization|person|breadcrumblist|imageobject)\b/i.test(entry.type)) return false;
      return Boolean(entry.name || entry.description);
    }).slice(0, 3).map((entry, index) => ({
      title: entry.headline || entry.name || entry.description,
      url: entry.url || canonicalUrl,
      repo: url.hostname,
      number: index + 1,
      author: entry.author,
      updatedAt: entry.datePublished,
      ...(entry.imageUrl ? { imageUrl: entry.imageUrl } : {}),
    })),
    ...links.slice(0, 7).map((link, index) => ({ title: link.title, url: link.url, repo: new URL(link.url).hostname, number: index + 1, author: "", updatedAt: "", ...(link.imageUrl ? { imageUrl: link.imageUrl } : {}) })),
    ...pageParagraphs.slice(0, 4).map((paragraph, index) => ({ title: paragraph, url: canonicalUrl, repo: url.hostname, number: index + 1, author: description, updatedAt: "" })),
    ...images.slice(0, 2).map((image, index) => ({ title: image.alt || image.title || `Page image ${index + 1}`, url: image.url, repo: url.hostname, number: index + 1, author: "", updatedAt: "", imageUrl: image.url })),
  ].filter((item, index, all) => all.findIndex((other) => other.title === item.title && other.url === item.url) === index)
    .slice(0, MAX_ITEMS);
  return {
    count: links.length,
    items,
    metadata,
  };
}

/** Fetches public, small static HTML pages, following a bounded number of safe redirects. */
export async function fetchWebsitePage(rawUrl: string, options: { imageIndexes?: number[]; searchText?: string } = {}): Promise<SourceData> {
  try {
    let currentUrl = rawUrl;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      const { url, address, family } = await checkedUrl(currentUrl);
      const result = await downloadHtml(url, address, family);
      if ("html" in result) {
        const data = extractWebsiteHtml(result.html, url, options.searchText, result.truncated ?? false);
        if (options.imageIndexes?.length) {
          // Fetch exactly the indices referenced by image nodes (up to three). Taking
          // the first two requested indices used to leave later image nodes without
          // bytes, even though the URL was present in the widget data.
          const imageItems = [...new Set(options.imageIndexes)].slice(0, 3)
            .map((index) => data.items[index])
            .filter((item) => item !== undefined);
          const assetCache = new Map<string, ImageAsset | null>();
          const getAsset = async (imageUrl: string) => {
            if (!assetCache.has(imageUrl)) assetCache.set(imageUrl, await fetchImageAsset(imageUrl));
            return assetCache.get(imageUrl) ?? null;
          };
          await Promise.all(imageItems.map(async (item) => {
            const candidates = [
              ...(item.imageUrl ? [item.imageUrl] : []),
              ...(data.metadata?.images ?? []).slice(0, 6).map((image) => image.url),
            ].filter((imageUrl, index, all) => all.indexOf(imageUrl) === index);
            for (const imageUrl of candidates) {
              const asset = await getAsset(imageUrl);
              if (!asset) continue;
              item.imageUrl = imageUrl;
              Object.assign(item, asset);
              return;
            }
          }));
        }
        return data;
      }
      if (redirect === MAX_REDIRECTS) {
        throw new HttpError(502, "WEBSITE_REDIRECT", "The webpage redirected too many times.");
      }
      try {
        currentUrl = new URL(result.redirect, url).toString();
      } catch {
        throw new HttpError(502, "WEBSITE_REDIRECT", "The webpage returned an invalid redirect.");
      }
    }
    throw new HttpError(502, "WEBSITE_REDIRECT", "The webpage redirected too many times.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "WEBSITE_UNAVAILABLE", "The webpage could not be loaded.");
  }
}
