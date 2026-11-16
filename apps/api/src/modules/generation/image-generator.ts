import { HttpError } from "../../lib/errors.js";

export type GeneratedImage = { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };
export type ImageGenerator = (prompt: string) => Promise<GeneratedImage>;

/** Uses the server's API key; browser sessions and ChatGPT cookies never enter the app. */
export function openAiImageGenerator(apiKey: string, model: string): ImageGenerator {
  return async (prompt) => {
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, size: "1024x1024", quality: "low", n: 1 }),
        signal: AbortSignal.timeout(75_000),
      });
    } catch {
      throw new HttpError(502, "IMAGE_PROVIDER_UNAVAILABLE", "The image service could not be reached. Try again shortly.");
    }

    if (response.status === 429) throw new HttpError(429, "IMAGE_RATE_LIMITED", "The image service is rate limiting requests. Try again shortly.");
    if (!response.ok) throw new HttpError(502, "IMAGE_GENERATION_FAILED", "The image service could not create that artwork. Try a simpler image description.");

    const payload = await response.json().catch(() => null) as { data?: Array<{ b64_json?: string }> } | null;
    const base64 = payload?.data?.[0]?.b64_json;
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new HttpError(502, "IMAGE_GENERATION_FAILED", "The image service returned no usable image. Try again.");
    }
    const bytes = Buffer.from(base64, "base64");
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.length > 4_000_000) {
      throw new HttpError(502, "IMAGE_GENERATION_FAILED", "The generated image was not a supported compact PNG.");
    }
    return { mediaType: "image/png", base64: bytes.toString("base64") };
  };
}
