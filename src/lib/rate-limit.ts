import { type NextFunction, type Request, type Response } from "express";

import { HttpError } from "./errors.js";

/**
 * Fixed-window rate limiter held in memory — correct for a single API process. Move
 * the counters to Redis (or Postgres) before running several replicas.
 */
export function rateLimit(options: { name: string; limit: number; windowMs: number; key: (req: Request) => string }) {
  const windows = new Map<string, { start: number; count: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = options.key(req);
    let entry = windows.get(key);
    if (!entry || now - entry.start >= options.windowMs) {
      entry = { start: now, count: 0 };
      windows.set(key, entry);
      if (windows.size > 50_000) {
        for (const [k, w] of windows) if (now - w.start >= options.windowMs) windows.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > options.limit) {
      const retryAfter = Math.ceil((entry.start + options.windowMs - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return next(new HttpError(429, "RATE_LIMITED", `Too many ${options.name} requests. Try again in ${retryAfter}s.`));
    }
    next();
  };
}
