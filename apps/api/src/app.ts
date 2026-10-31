import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";

const generationSchema = z
  .object({
    prompt: z.string().trim().min(5).max(500),
  })
  .strict();

export function buildApp() {
  const app = express();

  app.use(express.json({ limit: "16kb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "widgetcomposer-api",
    });
  });

  // Validate a user's widget-generation prompt
  app.post("/v1/widget-generations", (req, res) => {
    const result = generationSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Please enter a valid widget prompt.",
          details: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    // Step 1 only: validate the prompt.
    // We have not implemented AI or website fetching yet.

    return res.status(200).json({
      status: "validated",
      data: {
        prompt: result.data.prompt,
      },
      message: "Prompt received successfully.",
    });
  });

  // Handle unknown routes
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
      },
    });
  });

  // Centralized error handler — must be registered last.
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (res.headersSent) {
        return next(err);
      }

      const error = err as { status?: number; statusCode?: number };
      const status = error.statusCode ?? error.status;

      if (status === 400 || status === 413) {
        return res.status(status).json({
          error: {
            code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
            message:
              status === 413
                ? "Request body is too large."
                : "Invalid request body.",
          },
        });
      }

      console.error("Unexpected API error:", err);

      return res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred.",
        },
      });
    },
  );

  return app;
}