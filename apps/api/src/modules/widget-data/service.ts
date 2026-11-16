import { type Db, json } from "../../db/db.js";
import { HttpError, notFound } from "../../lib/errors.js";
import { parseBinding, type WidgetNode, type WidgetSpec } from "../../spec/widget-spec.js";
import { type ConnectorClient, ToolError } from "../connectors/composio.js";
import { GITHUB_TOOLKIT, runQuery, sampleData, type SourceData } from "../connectors/github.js";
import { requireClient } from "../connectors/service.js";
import { fetchWebsitePage } from "./website.js";
import { loadSpecImages } from "./assets.js";

/**
 * Widget data: resolves a spec's data sources through trusted connector code.
 *
 * Cache-first: the last good result per widget is kept in `widget_snapshots`. A
 * refresh that fails records the error and keeps serving the old data — good data is
 * never replaced by an empty or failed response.
 */

export type WidgetData = {
  /** Keyed by data source id. Null until the first successful fetch. */
  data: Record<string, SourceData> | null;
  fetchedAt: string | null;
  /** True when the data is older than the spec's refresh preference, or missing. */
  stale: boolean;
  lastError: string | null;
  /** The version the data was fetched for. */
  versionId: string;
};

type Deps = { db: Db; connectors: ConnectorClient | null };

function imageSources(node: WidgetNode, found = new Map<string, Set<number>>()): Map<string, Set<number>> {
  if (node.type === "image") {
    const binding = parseBinding(node.source);
    if (binding?.kind === "item") {
      const indexes = found.get(binding.source) ?? new Set<number>();
      indexes.add(binding.index);
      found.set(binding.source, indexes);
    }
  } else if (node.type === "column" || node.type === "row") {
    node.children.forEach((child) => imageSources(child, found));
  }
  return found;
}

async function fetchAll(deps: Deps, userId: string, spec: WidgetSpec): Promise<Record<string, SourceData>> {
  const imageIndexesBySource = imageSources(spec.root);
  const githubSources = spec.dataSources.filter((source) => source.connector === "github");
  const client = githubSources.length > 0 ? requireClient(deps.connectors) : null;
  if (client) {
    const accounts = await client.accounts(userId, GITHUB_TOOLKIT);
    if (accounts.length === 0) throw new HttpError(409, "CONNECTOR_REQUIRED", "Connect GitHub to load this widget's data.");
    if (!accounts.some((a) => a.status === "active")) {
      throw new HttpError(409, "CONNECTOR_NEEDS_REAUTH", "Reconnect GitHub to keep this widget updated.");
    }
  }
  try {
    const entries = await Promise.all(spec.dataSources.map(async (ds) => [
      ds.id,
      ds.connector === "github" && client
        ? await runQuery(client, userId, ds.query)
        : ds.connector === "website"
          ? await fetchWebsitePage(ds.url, { imageIndexes: [...(imageIndexesBySource.get(ds.id) ?? [])] })
          : { count: 0, items: [] },
    ] as const));
    return { ...Object.fromEntries(entries), ...await loadSpecImages(deps.db, userId, spec) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    console.warn(`[widget-data] user ${userId}: ${error.message}`);
    if (error.kind === "unauthorized") throw new HttpError(409, "CONNECTOR_NEEDS_REAUTH", "GitHub access was revoked. Reconnect GitHub.");
    if (error.kind === "rate_limited") throw new HttpError(429, "UPSTREAM_RATE_LIMITED", "GitHub rate limit reached.");
    throw new HttpError(502, "UPSTREAM_ERROR", error.message);
  }
}

/**
 * Data for a spec that is not saved yet. Uses the connected account when there is one,
 * otherwise sample data marked `sample: true` so the UI never mistakes it for real.
 */
export async function previewData(
  deps: Deps,
  userId: string,
  spec: WidgetSpec,
): Promise<{ data: Record<string, SourceData>; sample: boolean }> {
  const imageIndexesBySource = imageSources(spec.root);
  const githubSources = spec.dataSources.filter((source) => source.connector === "github");
  const accounts = deps.connectors && githubSources.length > 0 ? await deps.connectors.accounts(userId, GITHUB_TOOLKIT) : [];
  const hasGithub = githubSources.length > 0;
  const isGithubConnected = accounts.some((a) => a.status === "active");
  if (hasGithub && !isGithubConnected) {
    const entries = await Promise.all(spec.dataSources.map(async (ds) => [
      ds.id,
      ds.connector === "website" ? await fetchWebsitePage(ds.url, { imageIndexes: [...(imageIndexesBySource.get(ds.id) ?? [])] }) : sampleData(ds.query),
    ] as const));
    return { data: { ...Object.fromEntries(entries), ...await loadSpecImages(deps.db, userId, spec) }, sample: true };
  }
  return { data: await fetchAll(deps, userId, spec), sample: false };
}

export async function widgetData(deps: Deps, userId: string, widgetId: string, opts: { force: boolean }): Promise<WidgetData> {
  const widget = (
    await deps.db.query<{ current_version_id: string | null; spec_json: WidgetSpec | null; latest_id: string | null; latest_spec: WidgetSpec | null }>(
      `SELECT w.current_version_id, cv.spec_json, lv.id AS latest_id, lv.spec_json AS latest_spec
       FROM widgets w
       LEFT JOIN widget_versions cv ON cv.id = w.current_version_id
       LEFT JOIN LATERAL (
         SELECT id, spec_json FROM widget_versions WHERE widget_id = w.id ORDER BY version_number DESC LIMIT 1
       ) lv ON true
       WHERE w.id = $1 AND w.user_id = $2`,
      [widgetId, userId],
    )
  ).rows[0];
  if (!widget) throw notFound("Widget");

  // Devices render the published version; a draft falls back to its latest version.
  const versionId = widget.current_version_id ?? widget.latest_id;
  const spec = widget.current_version_id ? widget.spec_json : widget.latest_spec;
  if (!versionId || !spec) throw notFound("Version");

  const snapshot = (
    await deps.db.query<{ version_id: string; data_json: Record<string, SourceData> | null; fetched_at: Date | null; last_error: string | null }>(
      "SELECT version_id, data_json, fetched_at, last_error FROM widget_snapshots WHERE widget_id = $1",
      [widgetId],
    )
  ).rows[0];
  const sameVersion = snapshot?.version_id === versionId;
  const maxAgeMs = spec.presentation.refreshMinutes * 60_000;
  const age = snapshot?.fetched_at ? Date.now() - new Date(snapshot.fetched_at).getTime() : Infinity;

  const result = (data: Record<string, SourceData> | null, fetchedAt: Date | null, lastError: string | null): WidgetData => ({
    data,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    stale: !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > maxAgeMs,
    lastError,
    versionId,
  });

  if (sameVersion && !opts.force && age < maxAgeMs) {
    return result(snapshot.data_json, snapshot.fetched_at, snapshot.last_error);
  }

  try {
    const data = await fetchAll(deps, userId, spec);
    const now = new Date();
    await deps.db.query(
      `INSERT INTO widget_snapshots (widget_id, version_id, data_json, fetched_at, last_attempt_at, last_error)
       VALUES ($1, $2, $3::jsonb, $4, $4, NULL)
       ON CONFLICT (widget_id) DO UPDATE SET version_id = EXCLUDED.version_id, data_json = EXCLUDED.data_json,
         fetched_at = EXCLUDED.fetched_at, last_attempt_at = EXCLUDED.last_attempt_at, last_error = NULL`,
      [widgetId, versionId, json(data), now],
    );
    return result(data, now, null);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // Keep last good data for this version; data from a different version's sources is not reused.
    const keep = sameVersion ? snapshot : undefined;
    await deps.db.query(
      `INSERT INTO widget_snapshots (widget_id, version_id, data_json, fetched_at, last_attempt_at, last_error)
       VALUES ($1, $2, $3::jsonb, $4, now(), $5)
       ON CONFLICT (widget_id) DO UPDATE SET version_id = EXCLUDED.version_id, data_json = EXCLUDED.data_json,
         fetched_at = EXCLUDED.fetched_at, last_attempt_at = EXCLUDED.last_attempt_at, last_error = EXCLUDED.last_error`,
      [widgetId, versionId, keep?.data_json ? json(keep.data_json) : null, keep?.fetched_at ?? null, error.message],
    );
    if (!keep?.data_json) throw error;
    return result(keep.data_json, keep.fetched_at, error.message);
  }
}
