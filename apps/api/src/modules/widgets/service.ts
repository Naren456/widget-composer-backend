import { randomUUID } from "node:crypto";

import { type Db, json } from "../../db/db.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { SCHEMA_VERSION, type WidgetSpec } from "../../spec/widget-spec.js";

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
  status: WidgetView["status"];
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};
type VersionRow = {
  id: string;
  version_number: number;
  schema_version: number;
  source: VersionSource;
  spec_json: WidgetSpec;
  created_at: Date;
};

const iso = (d: Date) => new Date(d).toISOString();
const toVersion = (r: VersionRow): VersionView => ({
  id: r.id,
  versionNumber: r.version_number,
  schemaVersion: r.schema_version,
  source: r.source,
  spec: r.spec_json,
  createdAt: iso(r.created_at),
});

async function latestVersion(db: Db, widgetId: string): Promise<VersionView | null> {
  const row = (
    await db.query<VersionRow>(
      `SELECT id, version_number, schema_version, source, spec_json, created_at
       FROM widget_versions WHERE widget_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [widgetId],
    )
  ).rows[0];
  return row ? toVersion(row) : null;
}

async function ownedWidget(db: Db, userId: string, widgetId: string): Promise<WidgetRow> {
  const row = (
    await db.query<WidgetRow>(
      "SELECT id, name, status, current_version_id, created_at, updated_at FROM widgets WHERE id = $1 AND user_id = $2",
      [widgetId, userId],
    )
  ).rows[0];
  if (!row) throw notFound("Widget");
  return row;
}

async function view(db: Db, row: WidgetRow): Promise<WidgetView> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    currentVersionId: row.current_version_id,
    latestVersion: await latestVersion(db, row.id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listWidgets(db: Db, userId: string, includeArchived: boolean): Promise<WidgetView[]> {
  const { rows } = await db.query<WidgetRow>(
    `SELECT id, name, status, current_version_id, created_at, updated_at FROM widgets
     WHERE user_id = $1 AND ($2 OR status <> 'archived') ORDER BY updated_at DESC LIMIT 200`,
    [userId, includeArchived],
  );
  return Promise.all(rows.map((r) => view(db, r)));
}

export async function getWidget(db: Db, userId: string, widgetId: string): Promise<WidgetView> {
  return view(db, await ownedWidget(db, userId, widgetId));
}

/** Verifies a generation run belongs to the user before a version links to it. */
async function checkRun(db: Db, userId: string, runId: string | undefined): Promise<string | null> {
  if (!runId) return null;
  const owned = (await db.query("SELECT 1 FROM generation_runs WHERE id = $1 AND user_id = $2", [runId, userId])).rows.length > 0;
  if (!owned) throw new HttpError(400, "INVALID_REQUEST", "generationRunId does not belong to this user.");
  return runId;
}

export async function createWidget(
  db: Db,
  userId: string,
  input: { spec: WidgetSpec; generationRunId?: string },
): Promise<WidgetView> {
  const runId = await checkRun(db, userId, input.generationRunId);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO widgets (id, user_id, name) VALUES ($1, $2, $3)", [id, userId, input.spec.name]);
    await tx.query(
      `INSERT INTO widget_versions (id, widget_id, version_number, schema_version, spec_json, source, generation_run_id)
       VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6)`,
      [randomUUID(), id, SCHEMA_VERSION, json(input.spec), runId ? "generated" : "manual", runId],
    );
  });
  return getWidget(db, userId, id);
}

export async function addVersion(
  db: Db,
  userId: string,
  widgetId: string,
  input: { spec: WidgetSpec; generationRunId?: string },
): Promise<VersionView> {
  await ownedWidget(db, userId, widgetId);
  const runId = await checkRun(db, userId, input.generationRunId);
  const versionId = randomUUID();
  await db.transaction(async (tx) => {
    // Lock the widget so two concurrent saves cannot take the same version number.
    await tx.query("SELECT 1 FROM widgets WHERE id = $1 FOR UPDATE", [widgetId]);
    await tx.query(
      `INSERT INTO widget_versions (id, widget_id, version_number, schema_version, spec_json, source, generation_run_id)
       SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3, $4::jsonb, $5, $6 FROM widget_versions WHERE widget_id = $2`,
      [versionId, widgetId, SCHEMA_VERSION, json(input.spec), runId ? "edited" : "manual", runId],
    );
    await tx.query("UPDATE widgets SET updated_at = now() WHERE id = $1", [widgetId]);
  });
  return (await getVersion(db, userId, widgetId, versionId))!;
}

export async function listVersions(db: Db, userId: string, widgetId: string): Promise<VersionView[]> {
  await ownedWidget(db, userId, widgetId);
  const { rows } = await db.query<VersionRow>(
    `SELECT id, version_number, schema_version, source, spec_json, created_at
     FROM widget_versions WHERE widget_id = $1 ORDER BY version_number DESC`,
    [widgetId],
  );
  return rows.map(toVersion);
}

export async function getVersion(db: Db, userId: string, widgetId: string, versionId: string): Promise<VersionView | null> {
  const row = (
    await db.query<VersionRow>(
      `SELECT v.id, v.version_number, v.schema_version, v.source, v.spec_json, v.created_at
       FROM widget_versions v JOIN widgets w ON w.id = v.widget_id
       WHERE v.id = $1 AND v.widget_id = $2 AND w.user_id = $3`,
      [versionId, widgetId, userId],
    )
  ).rows[0];
  return row ? toVersion(row) : null;
}

/** Makes a version the one devices render. Publishing an older version is a rollback. */
export async function publish(db: Db, userId: string, widgetId: string, versionId: string): Promise<WidgetView> {
  const row = await ownedWidget(db, userId, widgetId);
  if (row.status === "archived") throw new HttpError(409, "WIDGET_ARCHIVED", "Unarchive the widget before publishing it.");
  const version = await getVersion(db, userId, widgetId, versionId);
  if (!version) throw notFound("Version");
  await db.query(
    "UPDATE widgets SET current_version_id = $2, status = 'published', name = $3, updated_at = now() WHERE id = $1",
    [widgetId, versionId, version.spec.name],
  );
  return getWidget(db, userId, widgetId);
}

export async function updateWidget(
  db: Db,
  userId: string,
  widgetId: string,
  patch: { name?: string; archived?: boolean },
): Promise<WidgetView> {
  const row = await ownedWidget(db, userId, widgetId);
  const status = patch.archived === undefined ? row.status : patch.archived ? "archived" : row.current_version_id ? "published" : "draft";
  await db.query("UPDATE widgets SET name = $2, status = $3, updated_at = now() WHERE id = $1", [
    widgetId,
    patch.name ?? row.name,
    status,
  ]);
  return getWidget(db, userId, widgetId);
}

export async function deleteWidget(db: Db, userId: string, widgetId: string): Promise<void> {
  await ownedWidget(db, userId, widgetId);
  await db.query("DELETE FROM widgets WHERE id = $1 AND user_id = $2", [widgetId, userId]);
}

export type InstanceView = { id: string; deviceId: string; platformWidgetId: number; renderer: string; createdAt: string };

/** Records a home-screen placement so the server knows which widgets are live where. */
export async function registerInstance(
  db: Db,
  userId: string,
  widgetId: string,
  input: { deviceId: string; platformWidgetId: number; renderer: string },
): Promise<InstanceView> {
  await ownedWidget(db, userId, widgetId);
  const id = randomUUID();
  const row = (
    await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO widget_instances (id, widget_id, user_id, device_id, platform_widget_id, renderer)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, device_id, platform_widget_id)
       DO UPDATE SET widget_id = EXCLUDED.widget_id, renderer = EXCLUDED.renderer, status = 'active'
       RETURNING id, created_at`,
      [id, widgetId, userId, input.deviceId, input.platformWidgetId, input.renderer],
    )
  ).rows[0];
  return { id: row.id, ...input, createdAt: iso(row.created_at) };
}

export async function removeInstance(db: Db, userId: string, widgetId: string, instanceId: string): Promise<void> {
  const { rows } = await db.query(
    "UPDATE widget_instances SET status = 'removed' WHERE id = $1 AND widget_id = $2 AND user_id = $3 RETURNING id",
    [instanceId, widgetId, userId],
  );
  if (rows.length === 0) throw notFound("Instance");
}
