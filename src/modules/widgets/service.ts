import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@prisma/client";

import { HttpError, notFound } from "../../lib/errors.js";
import {
  addWidgetVersion,
  createWidgetWithFirstVersion,
  deleteOwnedWidget,
  findLatestVersion,
  findOwnedVersion,
  findOwnedVersions,
  findOwnedWidget,
  listOwnedWidgets,
  markPlatformInstanceRemoved,
  markWidgetInstanceRemoved,
  ownsGenerationRun,
  publishWidgetVersion,
  updateOwnedWidget,
  upsertWidgetInstance,
} from "../../repositories/widgets.repository.js";
import { type WidgetSpec } from "../../spec/widget-spec.js";

/**
 * Widgets and their immutable versions. Every query is scoped by user id, so a widget
 * id from another account behaves exactly like one that does not exist.
 */

export type VersionSource = "generated" | "edited" | "manual";

export type VersionView = {
  id: string;
  versionNumber: number;
  schemaVersion: number;
  source: VersionSource;
  spec: WidgetSpec;
  createdAt: string;
};

export type WidgetView = {
  id: string;
  name: string;
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  latestVersion: VersionView | null;
  createdAt: string;
  updatedAt: string;
};

type WidgetRow = {
  id: string;
  name: string;
  status: string;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type VersionRow = {
  id: string;
  versionNumber: number;
  schemaVersion: number;
  source: string;
  specJson: unknown;
  createdAt: Date;
};

const iso = (d: Date) => new Date(d).toISOString();
const toVersion = (r: VersionRow): VersionView => ({
  id: r.id,
  versionNumber: r.versionNumber,
  schemaVersion: r.schemaVersion,
  source: r.source as VersionSource,
  spec: r.specJson as WidgetSpec,
  createdAt: iso(r.createdAt),
});

async function latestVersion(db: PrismaClient, widgetId: string): Promise<VersionView | null> {
  const row = await findLatestVersion(db, widgetId);
  return row ? toVersion(row) : null;
}

async function ownedWidget(db: PrismaClient, userId: string, widgetId: string): Promise<WidgetRow> {
  const row = await findOwnedWidget(db, userId, widgetId);
  if (!row) throw notFound("Widget");
  return row;
}

async function view(db: PrismaClient, row: WidgetRow): Promise<WidgetView> {
  return {
    id: row.id,
    name: row.name,
    status: row.status as WidgetView["status"],
    currentVersionId: row.currentVersionId,
    latestVersion: await latestVersion(db, row.id),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function listWidgets(db: PrismaClient, userId: string, includeArchived: boolean): Promise<WidgetView[]> {
  const rows = await listOwnedWidgets(db, userId, includeArchived);
  return Promise.all(rows.map((row) => view(db, row)));
}

export async function getWidget(db: PrismaClient, userId: string, widgetId: string): Promise<WidgetView> {
  return view(db, await ownedWidget(db, userId, widgetId));
}

/** Verifies a generation run belongs to the user before a version links to it. */
async function checkRun(db: PrismaClient, userId: string, runId: string | undefined): Promise<string | null> {
  if (!runId) return null;
  const owned = await ownsGenerationRun(db, userId, runId);
  if (!owned) throw new HttpError(400, "INVALID_REQUEST", "generationRunId does not belong to this user.");
  return runId;
}

export async function createWidget(
  db: PrismaClient,
  userId: string,
  input: { spec: WidgetSpec; generationRunId?: string },
): Promise<WidgetView> {
  const runId = await checkRun(db, userId, input.generationRunId);
  const id = randomUUID();
  await createWidgetWithFirstVersion(db, {
    widgetId: id,
    versionId: randomUUID(),
    userId,
    name: input.spec.name,
    schemaVersion: input.spec.schemaVersion,
    spec: input.spec,
    source: runId ? "generated" : "manual",
    generationRunId: runId,
  });
  return getWidget(db, userId, id);
}

export async function addVersion(
  db: PrismaClient,
  userId: string,
  widgetId: string,
  input: { spec: WidgetSpec; generationRunId?: string },
): Promise<VersionView> {
  await ownedWidget(db, userId, widgetId);
  const runId = await checkRun(db, userId, input.generationRunId);
  const versionId = randomUUID();
  await addWidgetVersion(db, {
    widgetId,
    versionId,
    schemaVersion: input.spec.schemaVersion,
    spec: input.spec,
    source: runId ? "edited" : "manual",
    generationRunId: runId,
  });
  return (await getVersion(db, userId, widgetId, versionId))!;
}

export async function listVersions(db: PrismaClient, userId: string, widgetId: string): Promise<VersionView[]> {
  await ownedWidget(db, userId, widgetId);
  const rows = await findOwnedVersions(db, userId, widgetId);
  return rows.map((row) => toVersion(row));
}

export async function getVersion(db: PrismaClient, userId: string, widgetId: string, versionId: string): Promise<VersionView | null> {
  const row = await findOwnedVersion(db, userId, widgetId, versionId);
  return row ? toVersion(row) : null;
}

/** Makes a version the one devices render. Publishing an older version is a rollback. */
export async function publish(db: PrismaClient, userId: string, widgetId: string, versionId: string): Promise<WidgetView> {
  const row = await ownedWidget(db, userId, widgetId);
  if (row.status === "archived") throw new HttpError(409, "WIDGET_ARCHIVED", "Unarchive the widget before publishing it.");
  const version = await getVersion(db, userId, widgetId, versionId);
  if (!version) throw notFound("Version");
  await publishWidgetVersion(db, userId, widgetId, versionId, version.spec.name);
  return getWidget(db, userId, widgetId);
}

export async function updateWidget(
  db: PrismaClient,
  userId: string,
  widgetId: string,
  patch: { name?: string; archived?: boolean },
): Promise<WidgetView> {
  const row = await ownedWidget(db, userId, widgetId);
  const status = patch.archived === undefined ? row.status : patch.archived ? "archived" : row.currentVersionId ? "published" : "draft";
  await updateOwnedWidget(db, userId, widgetId, { name: patch.name ?? row.name, status });
  return getWidget(db, userId, widgetId);
}

export async function deleteWidget(db: PrismaClient, userId: string, widgetId: string): Promise<void> {
  await ownedWidget(db, userId, widgetId);
  await deleteOwnedWidget(db, userId, widgetId);
}

export type InstanceView = { id: string; deviceId: string; platformWidgetId: number; renderer: string; createdAt: string };

/** Records a home-screen placement so the server knows which widgets are live where. */
export async function registerInstance(
  db: PrismaClient,
  userId: string,
  widgetId: string,
  input: { deviceId: string; platformWidgetId: number; renderer: string },
): Promise<InstanceView> {
  await ownedWidget(db, userId, widgetId);
  const row = await upsertWidgetInstance(db, { widgetId, userId, ...input });
  return { id: row.id, ...input, createdAt: iso(row.createdAt) };
}

export async function removeInstance(db: PrismaClient, userId: string, widgetId: string, instanceId: string): Promise<void> {
  const result = await markWidgetInstanceRemoved(db, { id: instanceId, widgetId, userId });
  if (result.count === 0) throw notFound("Instance");
}

/** Idempotently marks a launcher placement removed using its app-install identity. */
export async function removeInstanceByPlatform(
  db: PrismaClient,
  userId: string,
  widgetId: string,
  input: { deviceId: string; platformWidgetId: number },
): Promise<void> {
  await ownedWidget(db, userId, widgetId);
  await markPlatformInstanceRemoved(db, { widgetId, userId, ...input });
}
