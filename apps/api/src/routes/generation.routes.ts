import { Router } from "express";
import { z } from "zod";

import { type Deps } from "../deps.js";
import { HttpError, parse } from "../lib/errors.js";
import { devLog } from "../lib/logger.js";
import { currentUser } from "../modules/auth/auth.js";
import { generateSpec } from "../modules/generation/service.js";
import { reviewWidgetDesign } from "../modules/generation/design-review.js";
import { LlmUnavailableError } from "../modules/generation/llm.js";
import { previewData } from "../modules/widget-data/service.js";
import { storeWidgetImage } from "../modules/widget-data/assets.js";
import { getWidget } from "../modules/widgets/service.js";
import {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type WidgetSpec,
  validateSpec,
} from "../spec/widget-spec.js";
import { COMPONENT_CATALOG, WIDGET_ACTIONS, WIDGET_FONT_FAMILIES, WIDGET_SIZES, WIDGET_THEMES } from "../spec/component-catalog.js";
import { DATA_PROVIDER_CATALOG } from "../spec/provider-catalog.js";
import { prompt, rendererId, specFrom, userRateLimit } from "./shared.js";

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

export function generationRoutes(deps: Deps): Router {
  const router = Router();
  const { db, config } = deps;

  router.get("/widgets/components", (_req, res) => {
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

  router.post("/widgets/generate", userRateLimit("generation", 10), async (req, res) => {
    if (!deps.llm) throw new HttpError(503, "LLM_UNAVAILABLE", "Widget generation is not configured on the server.");
    const body = parse(z.object({ prompt, widgetId: z.uuid().optional(), image: referenceImage.optional() }).strict(), req.body, "Please enter a valid widget prompt and reference image.");
    const userId = currentUser(res);
    let base: WidgetSpec | undefined;
    if (body.widgetId) {
      const widget = await getWidget(db, userId, body.widgetId);
      base = widget.latestVersion?.spec;
    }
    const imageAssetId = body.image ? await storeWidgetImage(db, userId, body.image.mediaType, body.image.base64) : undefined;
    let imageDescription: string | undefined;
    if (body.image && deps.imageDescriber) {
      const started = Date.now();
      try {
        imageDescription = (await deps.imageDescriber.describe(body.image)) || undefined;
        devLog("generation", "reference image described", {
          durationMs: Date.now() - started,
          characters: imageDescription?.length ?? 0,
        });
      } catch (error) {
        devLog("generation", "reference image description failed", {
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const { spec, runId } = await generateSpec(db, deps.llm, {
      userId,
      prompt: body.prompt,
      base,
      searchBaseUrl: config.SEARXNG_URL,
      image: body.image,
      imageDescription,
      imageAssetId,
    });
    res.json({ spec, generationRunId: runId });
  });

  router.post("/widgets/validate", (req, res) => {
    const body = parse(z.object({ spec: z.unknown(), renderer: rendererId.optional() }).strict(), req.body);
    const checked = validateSpec(body.spec, body.renderer);
    res.json(checked.ok ? { valid: true, issues: [] } : { valid: false, issues: checked.issues });
  });

  router.post("/widgets/validate-design", userRateLimit("design-review", 8), async (req, res) => {
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

  router.post("/widgets/preview-data", async (req, res) => {
    const body = parse(z.object({ spec: z.unknown() }).strict(), req.body);
    res.json(await previewData(deps, currentUser(res), specFrom(body.spec)));
  });

  return router;
}
