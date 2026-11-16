import { Composio } from "@composio/core";

/**
 * Connected accounts through Composio. Composio runs the OAuth flow and holds the
 * provider tokens, so this API never sees or stores them; it only asks Composio to run
 * read-only tools on behalf of a user id (our user id is the Composio user id).
 */

export type AccountStatus = "active" | "needs_reauth";
export type ConnectedAccount = { id: string; status: AccountStatus; createdAt: string };

export interface ConnectorClient {
  /** A Composio link the user opens to connect `toolkit`; Composio returns to `callbackUrl`. */
  connectLink(userId: string, toolkit: string, callbackUrl: string): Promise<string>;
  /** The user's accounts for `toolkit`, leaving out connections that were never completed. */
  accounts(userId: string, toolkit: string): Promise<ConnectedAccount[]>;
  disconnect(accountId: string): Promise<void>;
  /** Runs a tool and returns its data, or throws ToolError. */
  execute(userId: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Fetches the authenticated account's contribution calendar without exposing its token. */
  githubContributionCalendar?(userId: string): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly kind: "unauthorized" | "rate_limited" | "upstream",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const TIMEOUT_MS = 15_000;
const PENDING = new Set(["INITIALIZING", "INITIATED"]);

/** Composio reports failures as text, so the kind is read from the message. */
function classify(message: string): ToolError["kind"] {
  if (/\b401\b|unauthori[sz]ed|bad credentials|no connected account|not connected|expired|revoked/i.test(message)) return "unauthorized";
  if (/\b429\b|rate limit/i.test(message)) return "rate_limited";
  return "upstream";
}

export function composioClient(apiKey: string, authConfigId?: string): ConnectorClient {
  const composio = new Composio({ apiKey });
  const authConfigs = new Map<string, string>();

  /** The configured auth config, else the project's existing one, else a Composio-managed one. */
  async function authConfigFor(toolkit: string): Promise<string> {
    if (authConfigId) return authConfigId;
    const known = authConfigs.get(toolkit);
    if (known) return known;
    const existing = (await composio.authConfigs.list({ toolkit })).items[0]?.id;
    const id = existing ?? (await composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth" })).id;
    authConfigs.set(toolkit, id);
    return id;
  }

  return {
    async connectLink(userId, toolkit, callbackUrl) {
      const request = await composio.connectedAccounts.link(userId, await authConfigFor(toolkit), { callbackUrl });
      if (!request.redirectUrl) throw new ToolError("Composio did not return a connect link.", "upstream");
      return request.redirectUrl;
    },

    async accounts(userId, toolkit) {
      const { items } = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit] });
      return items
        .filter((a) => !PENDING.has(a.status))
        .map((a) => ({ id: a.id, status: a.status === "ACTIVE" && !a.isDisabled ? "active" : "needs_reauth", createdAt: a.createdAt }));
    },

    async disconnect(accountId) {
      await composio.connectedAccounts.delete(accountId);
    },

    async execute(userId, tool, args) {
      let result;
      try {
        result = await composio.tools.execute(
          tool,
          { userId, arguments: args, dangerouslySkipVersionCheck: true },
          { signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Composio ${tool} failed: ${message}`, classify(message));
      }
      if (!result.successful) {
        const message = result.error ?? "unknown error";
        throw new ToolError(`Composio ${tool} failed: ${message}`, classify(message));
      }
      return result.data;
    },

    async githubContributionCalendar(userId) {
      const accounts = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ["github"] });
      const account = accounts.items.find((item) => item.status === "ACTIVE" && !item.isDisabled);
      if (!account) throw new ToolError("No active GitHub account is connected.", "unauthorized");
      try {
        const response = await composio.tools.proxyExecute(
          {
            endpoint: "https://api.github.com/graphql",
            method: "POST",
            connectedAccountId: account.id,
            parameters: [{ name: "Content-Type", value: "application/json", in: "header" }],
            body: {
              query: "query WidgetContributionCalendar { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } } } } }",
            },
          },
          { signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (response.status === 401 || response.status === 403) {
          throw new ToolError("GitHub denied contribution calendar access. Reconnect GitHub with read access.", "unauthorized");
        }
        if (response.status === 429) throw new ToolError("GitHub rate limit reached.", "rate_limited");
        if (response.status < 200 || response.status >= 300) {
          throw new ToolError(`GitHub contribution calendar returned HTTP ${response.status}.`, "upstream");
        }
        return response.data;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Composio GitHub contribution request failed: ${message}`, classify(message));
      }
    },
  };
}
