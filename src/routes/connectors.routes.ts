import { Router } from "express";

import { type Deps } from "../deps.js";
import { HttpError } from "../lib/errors.js";

/**
 * GitHub data is read from the public API for the username stored on each widget,
 * so there is no account to connect. These routes keep the response shape the app
 * already calls.
 */
export function connectorRoutes(_deps: Deps): Router {
  const router = Router();

  router.get("/connectors", (_req, res) => {
    res.json({ connectors: [] });
  });
  router.post("/connectors/github/connect", async () => {
    throw new HttpError(409, "CONNECTOR_NOT_REQUIRED", "GitHub data comes from the public API; name the GitHub username in your prompt.");
  });
  router.delete("/connectors/:id", async () => {
    throw new HttpError(404, "NOT_FOUND", "Connector not found.");
  });

  return router;
}
