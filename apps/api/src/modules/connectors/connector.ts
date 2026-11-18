import { HttpError } from "../../lib/errors.js";

/**
 * GitHub data comes from GitHub's public API — no OAuth tokens, no third party.
 * The account is supplied per widget: the user names a GitHub username in the prompt
 * and generation stores it on that widget's GitHub data sources.
 */

export interface GitHubApi {
  /** `GET /search/issues` for one normalised qualifier set; returns GitHub's body. */
  searchIssues(qualifier: string): Promise<unknown>;
  /** Parsed contribution calendar from the named user's public profile page. */
  contributionCalendar(username: string): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly kind: "unauthorized" | "rate_limited" | "upstream" | "misconfigured",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Maps connector failures onto the API's error envelope. */
export function connectorHttpError(error: unknown): HttpError | null {
  if (!(error instanceof ToolError)) return null;
  if (error.kind === "misconfigured") return new HttpError(503, "CONNECTOR_CONFIGURATION_INVALID", error.message);
  if (error.kind === "unauthorized") return new HttpError(409, "CONNECTOR_NEEDS_REAUTH", error.message);
  if (error.kind === "rate_limited") return new HttpError(429, "UPSTREAM_RATE_LIMITED", error.message);
  return new HttpError(502, "CONNECTOR_UPSTREAM_ERROR", "GitHub could not complete the request. Try again shortly.");
}
