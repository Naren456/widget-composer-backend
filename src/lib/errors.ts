import { type NextFunction, type Request, type Response } from "express";
import { type ZodType } from "zod";

/**
 * Every error response has one shape:
 *   { error: { code, message, details? } }
 * Throw an HttpError from a handler; the error middleware renders it. Anything else is
 * logged and answered with a generic 500, so internals never leak to clients.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found.`);

/** Parses a request body or query with a Zod schema, or throws a 400 listing every issue. */
export function parse<T>(schema: ZodType<T>, input: unknown, message = "Invalid request."): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      message,
      result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}

/** Express 5 forwards rejected promises, so async handlers can simply throw. */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    res.locals.errorCode = err.code;
    res.locals.errorMessage = err.message;
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) },
    });
  }

  // Body-parser errors carry a status: malformed JSON (400) or an oversized body (413).
  const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
  if (status === 400 || status === 413) {
    res.locals.errorCode = status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST";
    res.locals.errorMessage = "bad request body";
    return res.status(status).json({
      error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
        message: status === 413 ? "Request body is too large." : "Invalid request body.",
      },
    });
  }

  console.error("Unexpected API error:", err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
}
