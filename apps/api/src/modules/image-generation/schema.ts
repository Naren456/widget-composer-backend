import { z } from "zod";

export const imageStyles = ["minimal", "abstract", "illustration", "gradient", "cyberpunk"] as const;
export const imageAspectRatios = ["square", "portrait", "landscape"] as const;

export const imageGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(5).max(1_000),
  style: z.enum(imageStyles).default("abstract"),
  aspectRatio: z.enum(imageAspectRatios).default("square"),
  referenceImage: z.object({
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64: z.string().min(100).max(4_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).strict().optional(),
}).strict();

export type ImageStyle = (typeof imageStyles)[number];
export type ImageAspectRatio = (typeof imageAspectRatios)[number];

export function dimensionsFor(aspectRatio: ImageAspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case "portrait": return { width: 832, height: 1248 };
    case "landscape": return { width: 1248, height: 832 };
    case "square": return { width: 1024, height: 1024 };
  }
}
