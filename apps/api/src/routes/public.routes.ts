import { Router } from "express";
import { z } from "zod";

import { type Deps } from "../deps.js";
import { parse } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { createDeviceUser, refreshSession } from "../modules/auth/auth.js";

export function publicRoutes(deps: Deps): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "widgetcomposer-api" });
  });
  router.post(
    "/v1/auth/device",
    rateLimit({ name: "sign-up", limit: 20, windowMs: 60 * 60_000, key: (req) => `device:${req.ip}` }),
    async (_req, res) => {
      res.status(201).json(await createDeviceUser(deps.db, deps.config.SESSION_SECRET));
    },
  );
  router.post(
    "/v1/auth/refresh",
    rateLimit({ name: "refresh", limit: 60, windowMs: 60 * 60_000, key: (req) => `refresh:${req.ip}` }),
    async (req, res) => {
      const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }).strict(), req.body);
      res.json(await refreshSession(deps.db, deps.config.SESSION_SECRET, body.refreshToken));
    },
  );
  router.get("/v1/connectors/github/callback", (req, res) => {
    const url = new URL(deps.config.APP_REDIRECT_URL);
    url.searchParams.set("provider", "github");
    url.searchParams.set("status", req.query.status === "success" ? "connected" : "error");
    res.redirect(302, url.toString());
  });

  return router;
}
