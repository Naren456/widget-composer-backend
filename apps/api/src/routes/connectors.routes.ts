import { Router } from "express";

import { type Deps } from "../deps.js";
import { currentUser } from "../modules/auth/auth.js";
import { connectGitHub, disconnect, listConnectors, requireClient } from "../modules/connectors/service.js";

export function connectorRoutes(deps: Deps): Router {
  const router = Router();

  router.get("/connectors", async (_req, res) => {
    res.json({ connectors: await listConnectors(deps.connectors, currentUser(res)) });
  });
  router.post("/connectors/github/connect", async (_req, res) => {
    res.json({
      authorizeUrl: await connectGitHub(requireClient(deps.connectors), deps.config, currentUser(res)),
    });
  });
  router.delete("/connectors/:id", async (req, res) => {
    await disconnect(requireClient(deps.connectors), currentUser(res), req.params.id);
    res.status(204).end();
  });

  return router;
}
