import { type Db } from "../../db/db.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { type ImageAssetMetadata } from "./service.js";

type AssetRow = {
  id: string;
  prompt: string;
  model: string;
  style: string;
  media_type: string;
  width: number | null;
  height: number | null;
  created_at: Date;
};

const toMetadata = (row: AssetRow): ImageAssetMetadata => ({
  id: row.id,
  prompt: row.prompt,
  model: row.model,
  style: row.style,
  mediaType: row.media_type,
  width: row.width,
  height: row.height,
  createdAt: new Date(row.created_at).toISOString(),
});

export async function listImageAssets(db: Db, userId: string): Promise<ImageAssetMetadata[]> {
  const { rows } = await db.query<AssetRow>(
    `SELECT id, prompt, model, style, media_type, width, height, created_at
     FROM widget_image_assets WHERE user_id = $1 AND expires_at IS NULL
     ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return rows.map(toMetadata);
}

export async function getImageAsset(db: Db, userId: string, assetId: string) {
  const row = (
    await db.query<AssetRow & { image_data: Buffer | Uint8Array }>(
      `SELECT id, prompt, model, style, media_type, width, height, created_at, image_data
       FROM widget_image_assets WHERE id = $1 AND user_id = $2 AND expires_at IS NULL`,
      [assetId, userId],
    )
  ).rows[0];
  if (!row) throw notFound("Image asset");
  return { asset: toMetadata(row), imageData: Buffer.from(row.image_data).toString("base64") };
}

export async function deleteImageAsset(db: Db, userId: string, assetId: string): Promise<void> {
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM widget_image_assets WHERE id = $1 AND user_id = $2 AND expires_at IS NULL`,
      [assetId, userId],
    )
  ).rows[0];
  if (!row) throw notFound("Image asset");
  const referenced = await db.query(
    "SELECT 1 FROM widget_versions WHERE spec_json::text LIKE $1 LIMIT 1",
    [`%${assetId}%`],
  );
  if (referenced.rows.length > 0) {
    throw new HttpError(409, "IMAGE_ASSET_IN_USE", "Remove this image from every saved widget version before deleting it.");
  }
  await db.query("DELETE FROM widget_image_assets WHERE id = $1 AND user_id = $2", [assetId, userId]);
}
