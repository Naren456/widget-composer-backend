import { Router } from "express";

import { type Deps } from "../deps.js";
import { currentUser } from "../modules/auth/auth.js";
import { getImageAsset, deleteImageAsset, listImageAssets } from "../modules/image-assets/assets.js";
import { id, imageAssetUrl } from "./shared.js";

export function imageAssetRoutes(deps: Deps): Router {
  const router = Router();
  const { db } = deps;

  router.get("/image-assets", async (_req, res) => {
    const assets = await listImageAssets(db, currentUser(res));
    res.json({ assets: assets.map((asset) => ({ ...asset, imageUrl: imageAssetUrl(deps, asset.id) })) });
  });

  router.get("/image-assets/:id", async (req, res) => {
    const asset = await getImageAsset(db, currentUser(res), id(req.params.id, "Image asset"));
    res.json({ ...asset, imageUrl: imageAssetUrl(deps, asset.asset.id) });
  });

  router.delete("/image-assets/:id", async (req, res) => {
    await deleteImageAsset(db, currentUser(res), id(req.params.id, "Image asset"));
    res.status(204).end();
  });

  return router;
}
