import assert from "node:assert/strict";
import { test } from "node:test";

import { enrichNewsImages, linkedPageStories } from "../src/modules/widget-data/news.js";
import { extractWebsiteHtml } from "../src/modules/widget-data/website.js";
import { type SourceData } from "../src/modules/connectors/github.js";

test("publisher-page news fallback filters navigation and keeps linked article cards", () => {
  const publisherUrl = new URL("https://www.xda-developers.com/");
  const html = `
    <html>
      <head><title>XDA</title></head>
      <body>
        <a href="https://www.google.com/preferences/source?q=xda">Add</a>
        <a href="https://profile.google.com/@xdavideo">Follow</a>
        <a href="/software-and-services/">Software and Services</a>
        <a href="/author/example/">An author name that looks like a headline</a>
        <a href="/tag/diy/">An article topic label that should be filtered</a>
        <a href="/latest-story/">This long linked headline is an actual article story<img src="/latest.jpg" alt="Latest story"></a>
      </body>
    </html>
  `;
  const page = extractWebsiteHtml(html, publisherUrl);
  const stories = linkedPageStories(page, publisherUrl);

  assert.deepEqual(stories.map((story) => story.title), [
    "This long linked headline is an actual article story",
  ]);
  assert.equal(stories[0].url, "https://www.xda-developers.com/latest-story/");
  assert.equal(stories[0].imageUrl, "https://www.xda-developers.com/latest.jpg");
  assert.equal(stories[0].sourceName, "www.xda-developers.com");
});

test("news images fall back to article-page images when the feed has no thumbnail", async () => {
  const items: SourceData["items"] = [{
    title: "Latest story",
    url: "https://publisher.example/latest-story",
    repo: "publisher.example",
    number: 0,
    author: "",
    updatedAt: "",
  }];
  const fetchedImages: string[] = [];

  await enrichNewsImages(
    items,
    [0],
    async () => ({
      count: 0,
      items: [],
      metadata: {
        title: "Latest story",
        description: "",
        canonicalUrl: items[0].url,
        logoUrl: "",
        headings: [],
        paragraphs: [],
        pageText: "",
        links: [],
        images: [{ url: "https://publisher.example/story.jpg", alt: "", title: "" }],
        structuredData: [],
      },
    }),
    async (url) => {
      fetchedImages.push(url);
      return url.endsWith("story.jpg") ? { imageData: "aW1hZ2U=", imageMimeType: "image/jpeg" } : null;
    },
  );

  assert.deepEqual(fetchedImages, ["https://publisher.example/story.jpg"]);
  assert.equal(items[0].imageUrl, "https://publisher.example/story.jpg");
  assert.equal(items[0].imageData, "aW1hZ2U=");
  assert.equal(items[0].imageMimeType, "image/jpeg");
});

test("news images try article-page candidates after a broken feed thumbnail", async () => {
  const items: SourceData["items"] = [{
    title: "Latest story",
    url: "https://publisher.example/latest-story",
    repo: "publisher.example",
    number: 0,
    author: "",
    updatedAt: "",
    imageUrl: "https://publisher.example/broken.jpg",
  }];
  const fetchedImages: string[] = [];

  await enrichNewsImages(
    items,
    [0],
    async () => ({
      count: 0,
      items: [],
      metadata: {
        title: "Latest story",
        description: "",
        canonicalUrl: items[0].url,
        logoUrl: "",
        headings: [],
        paragraphs: [],
        pageText: "",
        links: [],
        images: [{ url: "https://publisher.example/fallback.jpg", alt: "", title: "" }],
        structuredData: [],
      },
    }),
    async (url) => {
      fetchedImages.push(url);
      return url.endsWith("fallback.jpg") ? { imageData: "aW1hZ2U=", imageMimeType: "image/jpeg" } : null;
    },
  );

  assert.deepEqual(fetchedImages, [
    "https://publisher.example/broken.jpg",
    "https://publisher.example/fallback.jpg",
  ]);
  assert.equal(items[0].imageUrl, "https://publisher.example/fallback.jpg");
  assert.equal(items[0].imageData, "aW1hZ2U=");
});
