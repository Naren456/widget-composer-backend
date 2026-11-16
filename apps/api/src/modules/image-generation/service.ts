import { randomUUID } from "node:crypto";
import sharp from "sharp";

import { type Db } from "../../db/db.js";
import { HttpError } from "../../lib/errors.js";
import { type GeneratedImage } from "../generation/image-generator.js";
import { type ImageGenerationProvider } from "./provider.js";
import { type ImageAspectRatio, type ImageStyle, dimensionsFor } from "./schema.js";

const MAX_STORED_IMAGE_BYTES = 512_000;
const MAX_PROMPT_CHARS = 1_000;

const styleDirections: Record<ImageStyle, string> = {
  minimal: "Use a premium minimal visual style with restrained forms and generous negative space.",
  abstract: "Use elegant abstract shapes, subtle texture, and atmospheric depth.",
  illustration: "Use a polished editorial illustration style with simple readable shapes.",
  gradient: "Use a smooth layered gradient with delicate texture and soft light.",
  cyberpunk: "Use a refined cyberpunk palette with controlled neon lighting and deep atmospheric shadows.",
};

export function enhanceWidgetImagePrompt(prompt: string, style: ImageStyle): string {
  const clean = prompt.trim().replace(/\s+/g, " ").slice(0, MAX_PROMPT_CHARS);
  if (clean.length < 5) throw new HttpError(422, "INVALID_IMAGE_PROMPT", "Describe the image you want in at least 5 characters.");
  return `${clean}. ${styleDirections[style]} Create artwork suitable for an Android home-screen widget background. Keep the central area visually uncluttered for native text and controls. No text, letters, numbers, logos, UI, borders, or watermark.`;
}

export async function generateAndStoreImage(
  db: Db,
  provider: ImageGenerationProvider,
  userId: string,
  input: { prompt: string; style: ImageStyle; aspectRatio: ImageAspectRatio; referenceImage?: { mediaType: GeneratedImage["mediaType"]; base64: string } },
): Promise<ImageAssetMetadata> {
  const startedAt = Date.now();
  const prompt = enhanceWidgetImagePrompt(input.prompt, input.style);
  const { width, height } = dimensionsFor(input.aspectRatio);
  const generated = await provider({
    prompt,
    width,
    height,
    ...(input.referenceImage ? { referenceImage: input.referenceImage } : {}),
  });
  const optimized = await optimizeImage(Buffer.from(generated.base64, "base64"));
  const id = randomUUID();
  await db.query(
    `INSERT INTO widget_image_assets (id, user_id, media_type, image_data, expires_at, prompt, model, style, width, height)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)`,
    [id, userId, optimized.mediaType, optimized.bytes, input.prompt.trim(), provider.model ?? "configured-image-provider", input.style, optimized.width, optimized.height],
  );
  console.info("[image-generation] generated asset", {
    userId,
    assetId: id,
    model: provider.model ?? "configured-image-provider",
    style: input.style,
    aspectRatio: input.aspectRatio,
    outputBytes: optimized.bytes.length,
    durationMs: Date.now() - startedAt,
  });
  return {
    id,
    prompt: input.prompt.trim(),
    model: "flux.2-klein-4b",
    style: input.style,
    mediaType: optimized.mediaType,
    width: optimized.width,
    height: optimized.height,
    createdAt: new Date().toISOString(),
  };
}

export type ImageAssetMetadata = {
  id: string;
  prompt: string;
  model: string;
  style: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
};

export async function optimizeGeneratedImage(image: GeneratedImage): Promise<GeneratedImage> {
  const optimized = await optimizeImage(Buffer.from(image.base64, "base64"));
  return { mediaType: optimized.mediaType, base64: optimized.bytes.toString("base64") };
}

async function optimizeImage(bytes: Buffer): Promise<{ bytes: Buffer; mediaType: "image/jpeg"; width: number; height: number }> {
  try {
    const image = sharp(bytes, { limitInputPixels: 16_000_000 }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 8_000 || metadata.height > 8_000) {
      throw new Error("Invalid image dimensions");
    }
    for (const maxDimension of [1_024, 896, 768, 640]) {
      for (const quality of [84, 76, 68]) {
        const output = await sharp(bytes, { limitInputPixels: 16_000_000 })
          .rotate()
          .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        if (output.data.length <= MAX_STORED_IMAGE_BYTES && output.info.width && output.info.height) {
          return { bytes: output.data, mediaType: "image/jpeg", width: output.info.width, height: output.info.height };
        }
      }
    }
  } catch {
    throw new HttpError(502, "IMAGE_RESPONSE_INVALID", "The generated image could not be optimized for Android widgets.");
  }
  throw new HttpError(502, "IMAGE_TOO_LARGE", "The image could not be compressed to a widget-friendly size.");
}
