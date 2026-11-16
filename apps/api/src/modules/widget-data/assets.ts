import { randomUUID } from "node:crypto";

import { type Db } from "../../db/db.js";
import { HttpError } from "../../lib/errors.js";
import { type WidgetNode, type WidgetSpec } from "../../spec/widget-spec.js";
import { type SourceData } from "../connectors/github.js";

const ASSET_SOURCE = /^asset_([0-9a-f-]{36})$/i;

export function imageAssetIds(node: WidgetNode, found = new Set<string>()): Set<string> {
  if (node.type === "image") {
    const match = ASSET_SOURCE.exec(node.source);
    if (match) found.add(match[1]);
  } else if (node.type === "column" || node.type === "row") {
    node.children.forEach((child) => imageAssetIds(child, found));
  }
  return found;
}

export async function storeWidgetImage(db: Db, userId: string, mediaType: string, base64: string): Promise<string> {
  await db.query("DELETE FROM widget_image_assets WHERE expires_at <= now()");
  const id = randomUUID();
  await db.query(
    "INSERT INTO widget_image_assets (id, user_id, media_type, image_data) VALUES ($1, $2, $3, $4)",
    [id, userId, mediaType, Buffer.from(base64, "base64")],
  );
  return `asset_${id}`;
}

/** Validates ownership when an asset-bearing spec is saved and makes it durable. */
export async function retainSpecImages(db: Db, userId: string, spec: WidgetSpec): Promise<void> {
  const ids = imageAssetIds(spec.root);
  if (spec.presentation.backgroundImageAssetId) ids.add(spec.presentation.backgroundImageAssetId);
  for (const id of ids) {
    const result = await db.query(
      "UPDATE widget_image_assets SET expires_at = NULL WHERE id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > now()) RETURNING id",
      [id, userId],
    );
    if (result.rows.length === 0) throw new HttpError(422, "IMAGE_ASSET_UNAVAILABLE", "An attached widget image expired or does not belong to this account. Attach it again.");
  }
}

/** Resolves only unexpired or saved assets owned by the current account. */
export async function loadSpecImages(db: Db, userId: string, spec: WidgetSpec): Promise<Record<string, SourceData>> {
  const ids = [...imageAssetIds(spec.root)];
  if (spec.presentation.backgroundImageAssetId && !ids.includes(spec.presentation.backgroundImageAssetId)) {
    ids.push(spec.presentation.backgroundImageAssetId);
  }
  if (!ids.length) return {};
  const { rows } = await db.query<{ id: string; media_type: string; image_data: Buffer | Uint8Array }>(
    "SELECT id, media_type, image_data FROM widget_image_assets WHERE id = ANY($1::uuid[]) AND user_id = $2 AND (expires_at IS NULL OR expires_at > now())",
    [ids, userId],
  );
  const found = new Map(rows.map((row) => [row.id, row]));
  const data: Record<string, SourceData> = {};
  for (const id of ids) {
    const row = found.get(id);
    if (!row) throw new HttpError(422, "IMAGE_ASSET_UNAVAILABLE", "An attached widget image expired or is unavailable. Edit the widget and attach it again.");
    data[`asset_${id}`] = {
      count: 1,
      items: [{ title: "Attached image", url: "", repo: "", number: 0, author: "", updatedAt: "", imageUrl: "", imageData: Buffer.from(row.image_data).toString("base64"), imageMimeType: row.media_type }],
    };
  }
  return data;
}
