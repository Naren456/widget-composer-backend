import { Router } from "express";

import { type Deps } from "./deps.js";
import { requireUser } from "./modules/auth/auth.js";
import { rateLimit } from "./lib/rate-limit.js";
import { connectorRoutes } from "./routes/connectors.routes.js";
import { generationRoutes } from "./routes/generation.routes.js";
import { imageAssetRoutes } from "./routes/image-assets.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { widgetRoutes } from "./routes/widgets.routes.js";

export function routes(deps: Deps): Router {
  const router = Router();

  router.use(publicRoutes(deps));
  router.use(
    "/v1",
    requireUser(deps.config.SESSION_SECRET),
    rateLimit({ name: "API", limit: 120, windowMs: 60_000, key: (req) => `API:${req.res?.locals.userId ?? req.ip}` }),
  );
  router.use("/v1", generationRoutes(deps));
  router.use("/v1", widgetRoutes(deps));
  router.use("/v1", imageAssetRoutes(deps));
  router.use("/v1", connectorRoutes(deps));

  return router;
}
