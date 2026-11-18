import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@prisma/client";

import { HttpError } from "../../lib/errors.js";
import {
  createTemporaryImageAsset,
  deleteExpiredImageAssets,
  findAvailableImageAssets,
  retainOwnedImageAssets,
} from "../../repositories/image-assets.repository.js";
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

export async function storeWidgetImage(db: PrismaClient, userId: string, mediaType: string, base64: string): Promise<string> {
  await deleteExpiredImageAssets(db);
  const id = randomUUID();
  await createTemporaryImageAsset(db, { id, userId, mediaType, imageData: Buffer.from(base64, "base64") });
  return `asset_${id}`;
}

/** Validates ownership when an asset-bearing spec is saved and makes it durable. */
export async function retainSpecImages(db: PrismaClient, userId: string, spec: WidgetSpec): Promise<void> {
  const ids = imageAssetIds(spec.root);
  if (spec.presentation.backgroundImageAssetId) ids.add(spec.presentation.backgroundImageAssetId);
  if (!ids.size) return;
  const updated = await retainOwnedImageAssets(db, userId, [...ids]);
  if (updated.count !== ids.size) throw new HttpError(422, "IMAGE_ASSET_UNAVAILABLE", "An attached widget image expired or does not belong to this account. Attach it again.");
}

/** Resolves only unexpired or saved assets owned by the current account. */
export async function loadSpecImages(db: PrismaClient, userId: string, spec: WidgetSpec): Promise<Record<string, SourceData>> {
  const ids = [...imageAssetIds(spec.root)];
  if (spec.presentation.backgroundImageAssetId && !ids.includes(spec.presentation.backgroundImageAssetId)) {
    ids.push(spec.presentation.backgroundImageAssetId);
  }
  if (!ids.length) return {};
  const rows = await findAvailableImageAssets(db, userId, ids);
  const found = new Map(rows.map((row) => [row.id, row]));
  const data: Record<string, SourceData> = {};
  for (const id of ids) {
    const row = found.get(id);
    if (!row) throw new HttpError(422, "IMAGE_ASSET_UNAVAILABLE", "An attached widget image expired or is unavailable. Edit the widget and attach it again.");
    data[`asset_${id}`] = {
      count: 1,
      items: [{ title: "Attached image", url: "", repo: "", number: 0, author: "", updatedAt: "", imageUrl: "", imageData: Buffer.from(row.imageData).toString("base64"), imageMimeType: row.mediaType }],
    };
  }
  return data;
}
