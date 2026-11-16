import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";

import { HttpError } from "../src/lib/errors.js";
import { nvidiaImageGenerationProvider, type ImageGenerationProvider } from "../src/modules/image-generation/provider.js";
import { startServer } from "./helpers.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lAAAAABJRU5ErkJggg==", "base64");
const encodedPixel = `data:image/png;base64,${pixel.toString("base64")}`;

describe("NVIDIA image provider", () => {
  test("uses the documented NIM request fields and reads the NVIDIA image response", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ image: [encodedPixel] });
    };
    try {
      const provider = nvidiaImageGenerationProvider({
        apiKey: "test-key",
        model: "flux.2-klein-4b",
        apiUrl: "https://ai.api.nvidia.test/v1/genai/black-forest-labs/flux.2-klein-4b",
      });
      const result = await provider({
        prompt: "An uncluttered abstract widget background",
        width: 1024,
        height: 1024,
        referenceImage: { mediaType: "image/png", base64: pixel.toString("base64") },
      });
      assert.deepEqual(requestBody, {
        prompt: "An uncluttered abstract widget background",
        image: [`data:image/png;base64,${pixel.toString("base64")}`],
        width: 1024,
        height: 1024,
      });
      assert.equal(authorization, "Bearer test-key");
      assert.equal(result.mediaType, "image/png");
      assert.deepEqual(Buffer.from(result.base64, "base64"), pixel);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps provider rate limits and rejects malformed image payloads", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response("{}", { status: 429 });
      const provider = nvidiaImageGenerationProvider({ apiKey: "test-key", model: "flux.2-klein-4b", apiUrl: "https://nvidia.test" });
      await assert.rejects(() => provider({ prompt: "A nice background", width: 1024, height: 1024 }), (error: unknown) =>
        error instanceof HttpError && error.status === 429 && error.code === "IMAGE_RATE_LIMITED",
      );

      globalThis.fetch = async () => Response.json({ image: ["not-an-image"] });
      await assert.rejects(() => provider({ prompt: "A nice background", width: 1024, height: 1024 }), (error: unknown) =>
        error instanceof HttpError && error.status === 502 && error.code === "IMAGE_RESPONSE_INVALID",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries one transient 503 and maps request timeouts", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => ++calls === 1 ? new Response("", { status: 503 }) : Response.json({ image: encodedPixel });
      const provider = nvidiaImageGenerationProvider({ apiKey: "test-key", model: "flux.2-klein-4b", apiUrl: "https://nvidia.test" });
      assert.equal((await provider({ prompt: "A nice background", width: 1024, height: 1024 })).mediaType, "image/png");
      assert.equal(calls, 2);

      globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
      await assert.rejects(() => provider({ prompt: "A nice background", width: 1024, height: 1024 }), (error: unknown) =>
        error instanceof HttpError && error.status === 504 && error.code === "IMAGE_GENERATION_TIMEOUT",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("image-generation API and saved assets", () => {
  test("validates prompts, reports missing configuration, and maps provider failures", async () => {
    const unavailable = await startServer();
    const { accessToken } = await unavailable.signUp();
    assert.equal((await unavailable.request("/v1/image-generation/generate", {
      token: accessToken,
      body: { prompt: "A dark widget background" },
    })).status, 503);
    await unavailable.close();

    const provider: ImageGenerationProvider = async () => {
      throw new HttpError(429, "IMAGE_RATE_LIMITED", "Try later.");
    };
    const server = await startServer({ imageGenerationProvider: provider });
    const session = await server.signUp();
    assert.equal((await server.request("/v1/image-generation/generate", {
      token: session.accessToken,
      body: { prompt: "tiny" },
    })).status, 400);
    assert.equal((await server.request("/v1/image-generation/generate", {
      token: session.accessToken,
      body: { prompt: "A dark widget background" },
    })).status, 429);
    await server.close();
  });

  test("persists optimized generated artwork and supports owner-scoped retrieval and deletion", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2b173f" } }).png().toBuffer();
    const provider: ImageGenerationProvider = async () => ({ mediaType: "image/png", base64: png.toString("base64") });
    provider.model = "flux.2-klein-4b";
    const server = await startServer({ imageGenerationProvider: provider });
    const owner = await server.signUp();
    const other = await server.signUp();

    const generated = await server.request("/v1/image-generation/generate", {
      token: owner.accessToken,
      body: { prompt: "A violet abstract texture", style: "abstract", aspectRatio: "square" },
    });
    assert.equal(generated.status, 201);
    assert.equal(generated.body.asset.model, "flux.2-klein-4b");
    assert.equal(generated.body.imageUrl, `https://api.test/v1/image-assets/${generated.body.asset.id}`);
    const assetId = generated.body.asset.id as string;

    const listed = await server.request("/v1/image-assets", { token: owner.accessToken });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.assets.length, 1);
    assert.equal(listed.body.assets[0].id, assetId);

    const image = await server.request(`/v1/image-assets/${assetId}`, { token: owner.accessToken });
    assert.equal(image.status, 200);
    assert.equal(image.body.asset.mediaType, "image/jpeg");
    assert.ok(Buffer.from(image.body.imageData, "base64").length < 512_000);
    assert.equal((await server.request(`/v1/image-assets/${assetId}`, { token: other.accessToken })).status, 404);

    assert.equal((await server.request(`/v1/image-assets/${assetId}`, { method: "DELETE", token: owner.accessToken })).status, 204);
    assert.equal((await server.request(`/v1/image-assets/${assetId}`, { token: owner.accessToken })).status, 404);
    await server.close();
  });
});
