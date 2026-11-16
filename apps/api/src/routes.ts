import { Router } from "express";
import { z } from "zod";

import { type Deps } from "./deps.js";
import { HttpError, notFound, parse } from "./lib/errors.js";
import { rateLimit } from "./lib/rate-limit.js";
import { createDeviceUser, currentUser, refreshSession, requireUser } from "./modules/auth/auth.js";
import { connectGitHub, disconnect, listConnectors, requireClient } from "./modules/connectors/service.js";
import { generateSpec } from "./modules/generation/service.js";
import { reviewWidgetDesign } from "./modules/generation/design-review.js";
import { LlmUnavailableError } from "./modules/generation/llm.js";
import { previewData, widgetData } from "./modules/widget-data/service.js";
import { retainSpecImages, storeWidgetImage } from "./modules/widget-data/assets.js";
import { deleteImageAsset, getImageAsset, listImageAssets } from "./modules/image-generation/assets.js";
import { generateAndStoreImage } from "./modules/image-generation/service.js";
import { imageGenerationRequestSchema } from "./modules/image-generation/schema.js";
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
} from "./modules/widgets/service.js";
import {
  RENDERERS,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type RendererId,
  validateSpec,
  type WidgetSpec,
} from "./spec/widget-spec.js";
import { COMPONENT_CATALOG, WIDGET_ACTIONS, WIDGET_FONT_FAMILIES, WIDGET_SIZES, WIDGET_THEMES } from "./spec/component-catalog.js";
import { DATA_PROVIDER_CATALOG } from "./spec/provider-catalog.js";

const uuid = z.uuid();
/** Path ids that are not UUIDs are reported as not found, like ids of other users. */
const id = (value: unknown, what: string) => {
  if (!uuid.safeParse(value).success) throw notFound(what);
  return value as string;
};

/** Parses and fully validates a spec from a request body, or throws a 422 with every issue. */
function specFrom(input: unknown, renderer: RendererId = "android-remoteviews-v1"): WidgetSpec {
  const checked = validateSpec(input, renderer);
  if (!checked.ok) throw new HttpError(422, "INVALID_SPEC", "The widget spec is not valid.", checked.issues);
  return checked.spec;
}

const prompt = z.string().trim().min(5).max(4_000);
const rendererId = z.enum(Object.keys(RENDERERS) as [RendererId, ...RendererId[]]);
const referenceImage = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  base64: z.string().min(100).max(4_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Image must be base64 encoded."),
}).strict().superRefine((image, ctx) => {
  const bytes = Buffer.from(image.base64, "base64");
  const validSignature = image.mediaType === "image/jpeg"
    ? bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : image.mediaType === "image/png"
      ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  const canonical = bytes.toString("base64").replace(/=+$/, "") === image.base64.replace(/=+$/, "");
  if (!validSignature || !canonical) {
    ctx.addIssue({ code: "custom", path: ["base64"], message: "Image data does not match its declared image format." });
  }
});

export function routes(deps: Deps): Router {
  const { db, config } = deps;
  const router = Router();
  const auth = requireUser(config.SESSION_SECRET);
  const byUser = (name: string, limit: number, windowMs = 60_000) =>
    rateLimit({ name, limit, windowMs, key: (req) => `${name}:${req.res?.locals.userId ?? req.ip}` });

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "widgetcomposer-api" });
  });

  // --- Auth -------------------------------------------------------------------
  router.post(
    "/v1/auth/device",
    rateLimit({ name: "sign-up", limit: 20, windowMs: 60 * 60_000, key: (req) => `device:${req.ip}` }),
    async (_req, res) => {
      res.status(201).json(await createDeviceUser(db, config.SESSION_SECRET));
    },
  );

  router.post(
    "/v1/auth/refresh",
    rateLimit({ name: "refresh", limit: 60, windowMs: 60 * 60_000, key: (req) => `refresh:${req.ip}` }),
    async (req, res) => {
      const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }).strict(), req.body);
      res.json(await refreshSession(db, config.SESSION_SECRET, body.refreshToken));
    },
  );

  // Composio redirects the browser here after connecting, so it carries no bearer token.
  // It only forwards the outcome to the app; nothing is exchanged or stored here.
  router.get("/v1/connectors/github/callback", (req, res) => {
    const url = new URL(config.APP_REDIRECT_URL);
    url.searchParams.set("provider", "github");
    url.searchParams.set("status", req.query.status === "success" ? "connected" : "error");
    res.redirect(302, url.toString());
  });

  // Everything below requires a signed-in user.
  router.use("/v1", auth, byUser("API", 120));

  // --- Generation and validation ---------------------------------------------
  router.get("/v1/widgets/components", (_req, res) => {
    res.json({
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersions: SUPPORTED_SCHEMA_VERSIONS,
      components: COMPONENT_CATALOG,
      providers: DATA_PROVIDER_CATALOG,
      sizes: WIDGET_SIZES,
      themes: WIDGET_THEMES,
      fontFamilies: WIDGET_FONT_FAMILIES,
      actions: WIDGET_ACTIONS,
    });
  });

  router.post("/v1/widgets/generate", byUser("generation", 10), async (req, res) => {
    if (!deps.llm) throw new HttpError(503, "LLM_UNAVAILABLE", "Widget generation is not configured on the server.");
    const body = parse(z.object({ prompt, widgetId: uuid.optional(), image: referenceImage.optional() }).strict(), req.body, "Please enter a valid widget prompt and reference image.");
    const userId = currentUser(res);
    let base: WidgetSpec | undefined;
    if (body.widgetId) {
      const widget = await getWidget(db, userId, body.widgetId);
      base = widget.latestVersion?.spec;
    }
    const imageAssetId = body.image ? await storeWidgetImage(db, userId, body.image.mediaType, body.image.base64) : undefined;
    const { spec, runId } = await generateSpec(db, deps.llm, {
      userId,
      prompt: body.prompt,
      base,
      searchBaseUrl: config.SEARXNG_URL,
      image: body.image,
      imageAssetId,
      imageGenerator: deps.imageGenerator,
    });
    res.json({ spec, generationRunId: runId });
  });

  router.post("/v1/widgets/validate", (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), renderer: rendererId.optional() }).strict(), req.body);
    const checked = validateSpec(body.spec, body.renderer);
    res.json(checked.ok ? { valid: true, issues: [] } : { valid: false, issues: checked.issues });
  });

  router.post("/v1/widgets/validate-design", byUser("design-review", 8), async (req, res) => {
    if (!deps.llm) throw new HttpError(503, "LLM_UNAVAILABLE", "AI design review is not configured on the server.");
    const body = parse(z.object({ spec: z.unknown(), renderer: rendererId.optional() }).strict(), req.body);
    const spec = specFrom(body.spec, body.renderer);
    try {
      res.json({ valid: true, review: await reviewWidgetDesign(deps.llm, spec) });
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        throw new HttpError(error.code === "LLM_RATE_LIMITED" ? 429 : 503, error.code, `${error.message} Try again shortly.`);
      }
      throw new HttpError(502, "DESIGN_REVIEW_FAILED", "The AI design review could not be completed. Please try again.");
    }
  });

  router.post("/v1/image-generation/generate", byUser("image-generation", 3), async (req, res) => {
    if (!deps.imageGenerationProvider) {
      throw new HttpError(503, "IMAGE_GENERATION_UNAVAILABLE", "Image generation is not configured on the server.");
    }
    const body = parse(imageGenerationRequestSchema, req.body, "Enter a prompt and choose an image style and aspect ratio.");
    if (body.referenceImage) {
      const bytes = Buffer.from(body.referenceImage.base64, "base64");
      const validSignature = body.referenceImage.mediaType === "image/jpeg"
        ? bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : body.referenceImage.mediaType === "image/png"
          ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      if (!validSignature || bytes.length > 3_000_000) {
        throw new HttpError(422, "INVALID_REFERENCE_IMAGE", "Choose a valid JPEG, PNG, or WebP image smaller than 3 MB.");
      }
    }
    const asset = await generateAndStoreImage(db, deps.imageGenerationProvider, currentUser(res), body);
    const stored = await getImageAsset(db, currentUser(res), asset.id);
    res.status(201).json({
      asset,
      imageUrl: imageAssetUrl(asset.id),
      imageData: stored.imageData,
    });
  });

  router.get("/v1/image-assets", async (_req, res) => {
    const assets = await listImageAssets(db, currentUser(res));
    res.json({ assets: assets.map((asset) => ({ ...asset, imageUrl: imageAssetUrl(asset.id) })) });
  });

  router.get("/v1/image-assets/:id", async (req, res) => {
    const asset = await getImageAsset(db, currentUser(res), id(req.params.id, "Image asset"));
    res.json({ ...asset, imageUrl: imageAssetUrl(asset.asset.id) });
  });

  router.delete("/v1/image-assets/:id", async (req, res) => {
    await deleteImageAsset(db, currentUser(res), id(req.params.id, "Image asset"));
    res.status(204).end();
  });

  router.post("/v1/widgets/preview-data", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown() }).strict(), req.body);
    res.json(await previewData(deps, currentUser(res), specFrom(body.spec)));
  });

  // --- Widgets ----------------------------------------------------------------
  router.get("/v1/widgets", async (req, res) => {
    res.json({ widgets: await listWidgets(db, currentUser(res), req.query.includeArchived === "true") });
  });

  router.post("/v1/widgets", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), generationRunId: uuid.optional() }).strict(), req.body);
    const spec = specFrom(body.spec);
    await retainSpecImages(db, currentUser(res), spec);
    res.status(201).json(await createWidget(db, currentUser(res), { spec, generationRunId: body.generationRunId }));
  });

  router.get("/v1/widgets/:id", async (req, res) => {
    res.json(await getWidget(db, currentUser(res), id(req.params.id, "Widget")));
  });

  router.patch("/v1/widgets/:id", async (req, res) => {
    const body = parse(
      z
        .object({ name: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional() })
        .strict()
        .refine((b) => b.name !== undefined || b.archived !== undefined, "Nothing to update."),
      req.body,
    );
    res.json(await updateWidget(db, currentUser(res), id(req.params.id, "Widget"), body));
  });

  router.delete("/v1/widgets/:id", async (req, res) => {
    await deleteWidget(db, currentUser(res), id(req.params.id, "Widget"));
    res.status(204).end();
  });

  router.get("/v1/widgets/:id/versions", async (req, res) => {
    res.json({ versions: await listVersions(db, currentUser(res), id(req.params.id, "Widget")) });
  });

  router.post("/v1/widgets/:id/versions", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), generationRunId: uuid.optional() }).strict(), req.body);
    const spec = specFrom(body.spec);
    await retainSpecImages(db, currentUser(res), spec);
    const version = await addVersion(db, currentUser(res), id(req.params.id, "Widget"), {
      spec,
      generationRunId: body.generationRunId,
    });
    res.status(201).json(version);
  });

  router.post("/v1/widgets/:id/publish", async (req, res) => {
    const body = parse(z.object({ versionId: uuid }).strict(), req.body);
    res.json(await publish(db, currentUser(res), id(req.params.id, "Widget"), body.versionId));
  });

  router.get("/v1/widgets/:id/data", async (req, res) => {
    const force = req.query.refresh === "true";
    const userId = currentUser(res);
    if (force && !refreshLimiter(userId)) {
      throw new HttpError(429, "RATE_LIMITED", "Too many manual refreshes. Try again in a minute.");
    }
    res.json(await widgetData(deps, userId, id(req.params.id, "Widget"), { force }));
  });

  router.post("/v1/widgets/:id/instances", async (req, res) => {
    const body = parse(
      z
        .object({
          deviceId: z.string().regex(/^[\w-]{8,64}$/),
          platformWidgetId: z.number().int().min(0).max(2_147_483_647),
          renderer: rendererId,
        })
        .strict(),
      req.body,
    );
    res.status(201).json(await registerInstance(db, currentUser(res), id(req.params.id, "Widget"), body));
  });

  router.delete("/v1/widgets/:id/instances", async (req, res) => {
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

  router.delete("/v1/widgets/:id/instances/:instanceId", async (req, res) => {
    await removeInstance(db, currentUser(res), id(req.params.id, "Widget"), id(req.params.instanceId, "Instance"));
    res.status(204).end();
  });

  // --- Connectors -------------------------------------------------------------
  router.get("/v1/connectors", async (_req, res) => {
    res.json({ connectors: await listConnectors(deps.connectors, currentUser(res)) });
  });

  router.post("/v1/connectors/github/connect", async (_req, res) => {
    res.json({ authorizeUrl: await connectGitHub(requireClient(deps.connectors), config, currentUser(res)) });
  });

  router.delete("/v1/connectors/:id", async (req, res) => {
    await disconnect(requireClient(deps.connectors), currentUser(res), req.params.id);
    res.status(204).end();
  });

  function imageAssetUrl(assetId: string): string {
    return new URL(`/v1/image-assets/${assetId}`, config.PUBLIC_API_URL).toString();
  }

  return router;
}

/** Manual refreshes bypass the cache, so they get their own tighter budget: 6 a minute per user. */
const refreshWindows = new Map<string, number[]>();
function refreshLimiter(userId: string): boolean {
  const now = Date.now();
  const recent = (refreshWindows.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 6) return false;
  recent.push(now);
  refreshWindows.set(userId, recent);
  return true;
}
