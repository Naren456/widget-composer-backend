import { HttpError } from "../../lib/errors.js";
import { type GeneratedImage } from "../generation/image-generator.js";

export type ImageGenerationInput = {
  prompt: string;
  width: number;
  height: number;
  referenceImage?: { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };
};

export type ImageGenerationProvider = ((input: ImageGenerationInput) => Promise<GeneratedImage>) & { model?: string };

const MAX_RESPONSE_BYTES = 16_000_000;
const TIMEOUT_MS = 120_000;

/** NVIDIA Build's FLUX.2 Klein NIM endpoint; provider credentials never leave the API. */
export function nvidiaImageGenerationProvider(options: {
  apiKey: string;
  model: string;
  apiUrl: string;
}): ImageGenerationProvider {
  const generate: ImageGenerationProvider = async (input) => {
    const body = {
      prompt: input.prompt,
      image: input.referenceImage
        ? [`data:${input.referenceImage.mediaType};base64,${input.referenceImage.base64}`]
        : [],
      width: input.width,
      height: input.height,
    };

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(options.apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new HttpError(504, "IMAGE_GENERATION_TIMEOUT", "NVIDIA image generation took too long. Try again.");
        }
        throw new HttpError(502, "IMAGE_PROVIDER_UNAVAILABLE", "NVIDIA image generation could not be reached. Try again shortly.");
      }

      if ((response.status === 502 || response.status === 503) && attempt === 0) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      break;
    }

    if (response.status === 429) throw new HttpError(429, "IMAGE_RATE_LIMITED", "NVIDIA is rate limiting image requests. Try again later.");
    if (!response.ok) throw new HttpError(502, "IMAGE_GENERATION_FAILED", "NVIDIA could not create that image. Try a simpler prompt.");

    const payload = await response.json().catch(() => null) as { image?: string | string[] } | null;
    const encoded = Array.isArray(payload?.image) ? payload.image[0] : payload?.image;
    if (typeof encoded !== "string") {
      throw new HttpError(502, "IMAGE_RESPONSE_INVALID", "NVIDIA returned no image. Try again.");
    }

    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(encoded);
    const base64 = match?.[2] ?? encoded;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new HttpError(502, "IMAGE_RESPONSE_INVALID", "NVIDIA returned an unsupported image response.");
    }
    const bytes = Buffer.from(base64, "base64");
    const mediaType = imageMediaType(bytes);
    if (!mediaType || bytes.length > MAX_RESPONSE_BYTES || (match && match[1] !== mediaType)) {
      throw new HttpError(502, "IMAGE_RESPONSE_INVALID", "NVIDIA returned an invalid or oversized image.");
    }
    return { mediaType, base64: bytes.toString("base64") };
  };
  generate.model = options.model;
  return generate;
}

function imageMediaType(bytes: Buffer): GeneratedImage["mediaType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
