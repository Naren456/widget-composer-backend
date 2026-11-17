import express, { type NextFunction, type Request, type Response } from "express";

import { type Deps } from "./deps.js";
import { errorHandler } from "./lib/errors.js";
import { devLog } from "./lib/logger.js";
import { routes } from "./routes.js";

export type { Deps };

export function buildApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  // Behind one reverse proxy in production, so req.ip is the client, not the proxy.
  app.set("trust proxy", deps.config.NODE_ENV === "production" ? 1 : false);

  if (deps.config.NODE_ENV !== "test") app.use(requestLog);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(cors(deps.config.CORS_ORIGINS));
  // Only widget generation accepts a reference image; keep other JSON endpoints small.
  app.use("/v1/widgets/generate", express.json({ limit: "5mb" }));
  app.use(express.json({ limit: "64kb" }));

  app.use(routes(deps));

  // Handle unknown routes
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });
  // Centralized error handler — must be registered last.
  app.use(errorHandler);

  return app;
}

/** CORS for the allow-listed browser origins only. Native apps send no Origin and are unaffected. */
function cors(origins: string[]) {
  const allowed = new Set(origins);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(origin && allowed.has(origin) ? 204 : 404).end();
    next();
  };
}

/** One console line per request: method, path, status, duration, and the error code on failures. */
function requestLog(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();
  devLog("http", "request started", { method: req.method, path: req.path });
  res.on("finish", () => {
    const ms = Math.round(performance.now() - start);
    const code = res.locals.errorCode ? ` ${res.locals.errorCode}: ${res.locals.errorMessage}` : "";
    const line = `${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms${code}`;
    devLog("http", "request completed", { method: req.method, path: req.path, status: res.statusCode, durationMs: ms, errorCode: res.locals.errorCode });
    if (res.statusCode >= 500) console.error(line);
    else if (res.statusCode >= 400) console.warn(line);
    else console.log(line);
  });
  next();
}
