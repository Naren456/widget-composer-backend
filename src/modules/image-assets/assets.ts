import { type PrismaClient } from "@prisma/client";

import { HttpError, notFound } from "../../lib/errors.js";
import {
  deleteOwnedImageAsset,
  findSavedImageAsset,
  listSavedImageAssets,
  savedImageAssetExists,
  widgetVersionReferencesAsset,
} from "../../repositories/image-assets.repository.js";

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

export async function listImageAssets(db: PrismaClient, userId: string): Promise<ImageAssetMetadata[]> {
  const rows = await listSavedImageAssets(db, userId);
  return rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    model: row.model,
    style: row.style,
    mediaType: row.mediaType,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getImageAsset(db: PrismaClient, userId: string, assetId: string) {
  const row = await findSavedImageAsset(db, userId, assetId);
  if (!row) throw notFound("Image asset");
  return {
    asset: {
      id: row.id,
      prompt: row.prompt,
      model: row.model,
      style: row.style,
      mediaType: row.mediaType,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
    },
    imageData: Buffer.from(row.imageData).toString("base64"),
  };
}

export async function deleteImageAsset(db: PrismaClient, userId: string, assetId: string): Promise<void> {
  if (!(await savedImageAssetExists(db, userId, assetId))) throw notFound("Image asset");
  if (await widgetVersionReferencesAsset(db, assetId)) {
    throw new HttpError(409, "IMAGE_ASSET_IN_USE", "Remove this image from every saved widget version before deleting it.");
  }
  await deleteOwnedImageAsset(db, userId, assetId);
}
