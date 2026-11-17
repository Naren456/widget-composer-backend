import { type PrismaClient } from "@prisma/client";

export function deleteExpiredImageAssets(db: PrismaClient, now = new Date()) {
  return db.widgetImageAsset.deleteMany({ where: { expiresAt: { lte: now } } });
}

export function createTemporaryImageAsset(
  db: PrismaClient,
  input: { id: string; userId: string; mediaType: string; imageData: Uint8Array },
) {
  return db.widgetImageAsset.create({ data: { ...input, imageData: Uint8Array.from(input.imageData) } });
}

export function retainOwnedImageAssets(db: PrismaClient, userId: string, ids: string[], now = new Date()) {
  return db.widgetImageAsset.updateMany({
    where: {
      id: { in: ids },
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { expiresAt: null },
  });
}

export function findAvailableImageAssets(db: PrismaClient, userId: string, ids: string[], now = new Date()) {
  return db.widgetImageAsset.findMany({
    where: {
      id: { in: ids },
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, mediaType: true, imageData: true },
  });
}

export function countSavedImageAssets(db: PrismaClient, userId: string) {
  return db.widgetImageAsset.count({ where: { userId, expiresAt: null } });
}

export function createSavedImageAsset(
  db: PrismaClient,
  input: {
    id: string;
    userId: string;
    mediaType: string;
    imageData: Uint8Array;
    prompt: string;
    model: string;
    style: string;
    width: number;
    height: number;
  },
) {
  return db.widgetImageAsset.create({
    data: { ...input, imageData: Uint8Array.from(input.imageData), expiresAt: null },
  });
}

export function listSavedImageAssets(db: PrismaClient, userId: string) {
  return db.widgetImageAsset.findMany({
    where: { userId, expiresAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, prompt: true, model: true, style: true, mediaType: true, width: true, height: true, createdAt: true },
  });
}

export function findSavedImageAsset(db: PrismaClient, userId: string, id: string) {
  return db.widgetImageAsset.findFirst({
    where: { id, userId, expiresAt: null },
    select: { id: true, prompt: true, model: true, style: true, mediaType: true, width: true, height: true, createdAt: true, imageData: true },
  });
}

export function savedImageAssetExists(db: PrismaClient, userId: string, id: string) {
  return db.widgetImageAsset.findFirst({
    where: { id, userId, expiresAt: null },
    select: { id: true },
  });
}

export async function widgetVersionReferencesAsset(db: PrismaClient, assetId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM widget_versions WHERE spec_json::text LIKE ${`%${assetId}%`}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

export function deleteOwnedImageAsset(db: PrismaClient, userId: string, id: string) {
  return db.widgetImageAsset.deleteMany({ where: { id, userId } });
}
