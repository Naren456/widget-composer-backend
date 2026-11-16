import assert from "node:assert/strict";
import { test } from "node:test";

import { extractWebsiteHtml } from "../src/modules/widget-data/website.js";

test("homepage source items exclude generic structured-data placeholders", () => {
  const html = `
    <html>
      <head>
        <title>Publisher Home</title>
        <script type="application/ld+json">
          {"@graph":[{"@type":"WebSite"},{"@type":"Organization","name":"Publisher"}]}
        </script>
      </head>
      <body><a href="/latest-story">Latest story</a></body>
    </html>
  `;
  const data = extractWebsiteHtml(html, new URL("https://publisher.example/"));

  assert.ok(data.items.some((item) => item.title === "Latest story"));
  assert.ok(data.items.every((item) => !item.title.startsWith("Page detail")));
});
