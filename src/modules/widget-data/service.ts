import { Prisma, type PrismaClient } from "@prisma/client";
import { HttpError, notFound } from "../../lib/errors.js";
import {
  findWidgetData,
  findWidgetSnapshot,
  saveWidgetSnapshot,
} from "../../repositories/widget-data.repository.js";
import { parseBinding, type WidgetNode, type WidgetSpec } from "../../spec/widget-spec.js";
import {
  connectorConnectionStatus,
  connectorError,
  fetchConnectorData,
  requireConnectorConnection,
  sampleConnectorData,
} from "../connectors/data-connectors.js";
import { type GitHubApi, ToolError } from "../connectors/connector.js";
import { type SourceData } from "../connectors/github.js";
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

type Deps = { db: PrismaClient; github: GitHubApi };

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
  const context = (sourceId: string) => ({
    userId,
    github: deps.github,
    imageIndexes: [...(imageIndexesBySource.get(sourceId) ?? [])],
  });
  for (const source of spec.dataSources) {
    try {
      const status = await connectorConnectionStatus(source, context(source.id));
      requireConnectorConnection(source, status);
    }
    catch (error) {
      const mapped = connectorError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }
  try {
    const entries = await Promise.all(spec.dataSources.map(async (ds) => [
      ds.id,
      await fetchConnectorData(ds, context(ds.id)),
    ] as const));
    return { ...Object.fromEntries(entries), ...await loadSpecImages(deps.db, userId, spec) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    console.warn(`[widget-data] user ${userId}: ${error.kind}`);
    const mapped = connectorError(error);
    if (mapped) throw mapped;
    throw error;
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
  const context = (sourceId: string) => ({
    userId,
    github: deps.github,
    imageIndexes: [...(imageIndexesBySource.get(sourceId) ?? [])],
  });
  const statuses = new Map<string, Awaited<ReturnType<typeof connectorConnectionStatus>>>();
  for (const source of spec.dataSources) {
    try {
      statuses.set(source.id, await connectorConnectionStatus(source, context(source.id)));
    } catch (error) {
      const mapped = connectorError(error);
      if (mapped) throw mapped;
      throw error;
    }
  }
  let usedSample = false;
  try {
    const entries = await Promise.all(spec.dataSources.map(async (source) => {
      const status = statuses.get(source.id) ?? "connected";
      if (status !== "connected") {
        const sample = sampleConnectorData(source);
        if (sample) {
          usedSample = true;
          return [source.id, sample] as const;
        }
        requireConnectorConnection(source, status);
      }
      return [source.id, await fetchConnectorData(source, context(source.id))] as const;
    }));
    const data = { ...Object.fromEntries(entries), ...await loadSpecImages(deps.db, userId, spec) };
    return { data, sample: usedSample };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    console.warn(`[widget-data] user ${userId}: ${error.kind}`);
    const mapped = connectorError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export async function widgetData(deps: Deps, userId: string, widgetId: string, opts: { force: boolean }): Promise<WidgetData> {
  const widget = await findWidgetData(deps.db, widgetId, userId);
  if (!widget) throw notFound("Widget");

  // Devices render the published version; a draft falls back to its latest version.
  const latest = widget.versions[0];
  const versionId = widget.currentVersionId ?? latest?.id;
  const spec = widget.currentVersionId
    ? widget.currentVersion?.specJson as WidgetSpec | undefined
    : latest?.specJson as WidgetSpec | undefined;
  if (!versionId || !spec) throw notFound("Version");

  const snapshot = await findWidgetSnapshot(deps.db, widgetId);
  const sameVersion = snapshot?.versionId === versionId;
  const maxAgeMs = spec.presentation.refreshMinutes * 60_000;
  const age = snapshot?.fetchedAt ? Date.now() - snapshot.fetchedAt.getTime() : Infinity;

  const result = (data: Record<string, SourceData> | null, fetchedAt: Date | null, lastError: string | null): WidgetData => ({
    data,
    fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
    stale: !fetchedAt || Date.now() - fetchedAt.getTime() > maxAgeMs,
    lastError,
    versionId,
  });

  if (sameVersion && !opts.force && age < maxAgeMs) {
    return result(snapshot.dataJson as Record<string, SourceData> | null, snapshot.fetchedAt, snapshot.lastError);
  }

  try {
    const data = await fetchAll(deps, userId, spec);
    const now = new Date();
    await saveWidgetSnapshot(deps.db, {
      widgetId,
      versionId,
      dataJson: data,
      fetchedAt: now,
      lastAttemptAt: now,
      lastError: null,
    });
    return result(data, now, null);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // Keep last good data for this version; data from a different version's sources is not reused.
    const keep = sameVersion ? snapshot : undefined;
    await saveWidgetSnapshot(deps.db, {
      widgetId,
      versionId,
      dataJson: keep?.dataJson ? keep.dataJson as Prisma.InputJsonValue : Prisma.DbNull,
      fetchedAt: keep?.fetchedAt ?? null,
      lastAttemptAt: new Date(),
      lastError: error.message,
    });
    const lastGoodData = keep?.dataJson as Record<string, SourceData> | null | undefined;
    if (!lastGoodData) throw error;
    return result(lastGoodData, keep?.fetchedAt ?? null, error.message);
  }
}
