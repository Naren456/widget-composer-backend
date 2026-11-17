import { Router } from "express";
import { z } from "zod";

import { type Deps } from "../deps.js";
import { HttpError, parse } from "../lib/errors.js";
import { currentUser } from "../modules/auth/auth.js";
import { widgetData } from "../modules/widget-data/service.js";
import { retainSpecImages } from "../modules/widget-data/assets.js";
import {
  addVersion,
  createWidget,
  deleteWidget,
  getWidget,
  listVersions,
  listWidgets,
  publish,
  removeInstanceByPlatform,
  registerInstance,
  removeInstance,
  updateWidget,
} from "../modules/widgets/service.js";
import { allowManualRefresh, id, rendererId, specFrom, uuid } from "./shared.js";

export function widgetRoutes(deps: Deps): Router {
  const router = Router();
  const { db } = deps;

  router.get("/widgets", async (req, res) => {
    res.json({ widgets: await listWidgets(db, currentUser(res), req.query.includeArchived === "true") });
  });

  router.post("/widgets", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), generationRunId: uuid.optional() }).strict(), req.body);
    const spec = specFrom(body.spec);
    await retainSpecImages(db, currentUser(res), spec);
    res.status(201).json(await createWidget(db, currentUser(res), { spec, generationRunId: body.generationRunId }));
  });

  router.get("/widgets/:id", async (req, res) => {
    res.json(await getWidget(db, currentUser(res), id(req.params.id, "Widget")));
  });

  router.patch("/widgets/:id", async (req, res) => {
    const body = parse(
      z
        .object({ name: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional() })
        .strict()
        .refine((value) => value.name !== undefined || value.archived !== undefined, "Nothing to update."),
      req.body,
    );
    res.json(await updateWidget(db, currentUser(res), id(req.params.id, "Widget"), body));
  });

  router.delete("/widgets/:id", async (req, res) => {
    await deleteWidget(db, currentUser(res), id(req.params.id, "Widget"));
    res.status(204).end();
  });

  router.get("/widgets/:id/versions", async (req, res) => {
    res.json({ versions: await listVersions(db, currentUser(res), id(req.params.id, "Widget")) });
  });

  router.post("/widgets/:id/versions", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), generationRunId: uuid.optional() }).strict(), req.body);
    const spec = specFrom(body.spec);
    await retainSpecImages(db, currentUser(res), spec);
    const version = await addVersion(db, currentUser(res), id(req.params.id, "Widget"), {
      spec,
      generationRunId: body.generationRunId,
    });
    res.status(201).json(version);
  });

  router.post("/widgets/:id/publish", async (req, res) => {
    const body = parse(z.object({ versionId: uuid }).strict(), req.body);
    res.json(await publish(db, currentUser(res), id(req.params.id, "Widget"), body.versionId));
  });

  router.get("/widgets/:id/data", async (req, res) => {
    const force = req.query.refresh === "true";
    const userId = currentUser(res);
    if (force && !allowManualRefresh(userId)) {
      throw new HttpError(429, "RATE_LIMITED", "Too many manual refreshes. Try again in a minute.");
    }
    res.json(await widgetData(deps, userId, id(req.params.id, "Widget"), { force }));
  });

  router.post("/widgets/:id/instances", async (req, res) => {
    const body = parse(
      z.object({
        deviceId: z.string().regex(/^[\w-]{8,64}$/),
        platformWidgetId: z.number().int().min(0).max(2_147_483_647),
        renderer: rendererId,
      }).strict(),
      req.body,
    );
    res.status(201).json(await registerInstance(db, currentUser(res), id(req.params.id, "Widget"), body));
  });

  router.delete("/widgets/:id/instances", async (req, res) => {
    const body = parse(
      z.object({
        deviceId: z.string().regex(/^[\w-]{8,64}$/),
        platformWidgetId: z.number().int().min(0).max(2_147_483_647),
      }).strict(),
      req.body,
    );
    await removeInstanceByPlatform(db, currentUser(res), id(req.params.id, "Widget"), body);
    res.status(204).end();
  });

  router.delete("/widgets/:id/instances/:instanceId", async (req, res) => {
    await removeInstance(db, currentUser(res), id(req.params.id, "Widget"), id(req.params.instanceId, "Instance"));
    res.status(204).end();
  });

  return router;
}
