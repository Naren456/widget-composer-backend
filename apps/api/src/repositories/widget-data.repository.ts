import { type Prisma, type PrismaClient } from "@prisma/client";

export function findWidgetData(db: PrismaClient, widgetId: string, userId: string) {
  return db.widget.findFirst({
    where: { id: widgetId, userId },
    select: {
      currentVersionId: true,
      currentVersion: { select: { specJson: true } },
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { id: true, specJson: true },
      },
    },
  });
}

export function findWidgetSnapshot(db: PrismaClient, widgetId: string) {
  return db.widgetSnapshot.findUnique({ where: { widgetId } });
}

export function saveWidgetSnapshot(
  db: PrismaClient,
  input: {
    widgetId: string;
    versionId: string;
    dataJson: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    fetchedAt: Date | null;
    lastAttemptAt: Date;
    lastError: string | null;
  },
) {
  return db.widgetSnapshot.upsert({
    where: { widgetId: input.widgetId },
    create: input,
    update: {
      versionId: input.versionId,
      dataJson: input.dataJson,
      fetchedAt: input.fetchedAt,
      lastAttemptAt: input.lastAttemptAt,
      lastError: input.lastError,
    },
  });
}
