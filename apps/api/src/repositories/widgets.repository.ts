import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@prisma/client";

export async function findLatestVersion(db: PrismaClient, widgetId: string) {
  return db.widgetVersion.findFirst({
    where: { widgetId },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, schemaVersion: true, source: true, specJson: true, createdAt: true },
  });
}

export function findOwnedWidget(db: PrismaClient, userId: string, widgetId: string) {
  return db.widget.findFirst({
    where: { id: widgetId, userId },
    select: { id: true, name: true, status: true, currentVersionId: true, createdAt: true, updatedAt: true },
  });
}

export function listOwnedWidgets(db: PrismaClient, userId: string, includeArchived: boolean) {
  return db.widget.findMany({
    where: { userId, ...(includeArchived ? {} : { status: { not: "archived" } }) },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, name: true, status: true, currentVersionId: true, createdAt: true, updatedAt: true },
  });
}

export async function ownsGenerationRun(db: PrismaClient, userId: string, runId: string): Promise<boolean> {
  return (await db.generationRun.findFirst({ where: { id: runId, userId }, select: { id: true } })) !== null;
}

export async function createWidgetWithFirstVersion(
  db: PrismaClient,
  input: {
    widgetId: string;
    versionId: string;
    userId: string;
    name: string;
    schemaVersion: number;
    spec: object;
    source: string;
    generationRunId: string | null;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.widget.create({ data: { id: input.widgetId, userId: input.userId, name: input.name } });
    await tx.widgetVersion.create({
      data: {
        id: input.versionId,
        widgetId: input.widgetId,
        versionNumber: 1,
        schemaVersion: input.schemaVersion,
        specJson: input.spec,
        source: input.source,
        generationRunId: input.generationRunId,
      },
    });
  });
}

export async function addWidgetVersion(
  db: PrismaClient,
  input: {
    widgetId: string;
    versionId: string;
    schemaVersion: number;
    spec: object;
    source: string;
    generationRunId: string | null;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.widget.update({ where: { id: input.widgetId }, data: { updatedAt: new Date() } });
    const latest = await tx.widgetVersion.aggregate({
      where: { widgetId: input.widgetId },
      _max: { versionNumber: true },
    });
    await tx.widgetVersion.create({
      data: {
        id: input.versionId,
        widgetId: input.widgetId,
        versionNumber: (latest._max.versionNumber ?? 0) + 1,
        schemaVersion: input.schemaVersion,
        specJson: input.spec,
        source: input.source,
        generationRunId: input.generationRunId,
      },
    });
  });
}

export function findOwnedVersions(db: PrismaClient, userId: string, widgetId: string) {
  return db.widgetVersion.findMany({
    where: { widgetId, widget: { userId } },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, schemaVersion: true, source: true, specJson: true, createdAt: true },
  });
}

export function findOwnedVersion(db: PrismaClient, userId: string, widgetId: string, versionId: string) {
  return db.widgetVersion.findFirst({
    where: { id: versionId, widgetId, widget: { userId } },
    select: { id: true, versionNumber: true, schemaVersion: true, source: true, specJson: true, createdAt: true },
  });
}

export function publishWidgetVersion(db: PrismaClient, userId: string, widgetId: string, versionId: string, name: string) {
  return db.widget.updateMany({
    where: { id: widgetId, userId },
    data: { currentVersionId: versionId, status: "published", name, updatedAt: new Date() },
  });
}

export function updateOwnedWidget(db: PrismaClient, userId: string, widgetId: string, data: { name: string; status: string }) {
  return db.widget.updateMany({
    where: { id: widgetId, userId },
    data: { ...data, updatedAt: new Date() },
  });
}

export function deleteOwnedWidget(db: PrismaClient, userId: string, widgetId: string) {
  return db.widget.deleteMany({ where: { id: widgetId, userId } });
}

export async function upsertWidgetInstance(
  db: PrismaClient,
  input: { widgetId: string; userId: string; deviceId: string; platformWidgetId: number; renderer: string },
) {
  return db.widgetInstance.upsert({
    where: {
      userId_deviceId_platformWidgetId: {
        userId: input.userId,
        deviceId: input.deviceId,
        platformWidgetId: input.platformWidgetId,
      },
    },
    create: { id: randomUUID(), ...input },
    update: { widgetId: input.widgetId, renderer: input.renderer, status: "active" },
    select: { id: true, createdAt: true },
  });
}

export function markWidgetInstanceRemoved(db: PrismaClient, input: { id: string; userId: string; widgetId: string }) {
  return db.widgetInstance.updateMany({
    where: input,
    data: { status: "removed" },
  });
}

export function markPlatformInstanceRemoved(
  db: PrismaClient,
  input: { widgetId: string; userId: string; deviceId: string; platformWidgetId: number },
) {
  return db.widgetInstance.updateMany({
    where: { ...input, status: { not: "removed" } },
    data: { status: "removed" },
  });
}
