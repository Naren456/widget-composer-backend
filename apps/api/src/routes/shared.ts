import { z } from "zod";

import { type Deps } from "../deps.js";
import { HttpError, notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  RENDERERS,
  type RendererId,
  validateSpec,
  type WidgetSpec,
} from "../spec/widget-spec.js";

export const uuid = z.uuid();
export const prompt = z.string().trim().min(5).max(4_000);
export const rendererId = z.enum(Object.keys(RENDERERS) as [RendererId, ...RendererId[]]);

/** Path ids that are not UUIDs are reported as not found, like ids of other users. */
export function id(value: unknown, what: string): string {
  if (!uuid.safeParse(value).success) throw notFound(what);
  return value as string;
}

/** Parses and fully validates a spec from a request body, or throws a 422 with every issue. */
export function specFrom(input: unknown, renderer?: RendererId): WidgetSpec {
  const checked = validateSpec(input, renderer);
  if (!checked.ok) throw new HttpError(422, "INVALID_SPEC", "The widget spec is not valid.", checked.issues);
  return checked.spec;
}

export function userRateLimit(name: string, limit: number, windowMs = 60_000) {
  return rateLimit({ name, limit, windowMs, key: (req) => `${name}:${req.res?.locals.userId ?? req.ip}` });
}

export function imageAssetUrl(deps: Deps, assetId: string): string {
  return new URL(`/v1/image-assets/${assetId}`, deps.config.PUBLIC_API_URL).toString();
}

const refreshWindows = new Map<string, number[]>();

export function allowManualRefresh(userId: string): boolean {
  const now = Date.now();
  const recent = (refreshWindows.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= 6) return false;
  recent.push(now);
  refreshWindows.set(userId, recent);
  return true;
}
