import { type Config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { type AccountStatus, type ConnectorClient } from "./composio.js";
import { GITHUB_TOOLKIT } from "./github.js";

/**
 * The user's connected accounts. Composio owns the accounts and their tokens; this
 * module only lists, links and removes them for the signed-in user.
 */

export type ConnectorView = {
  id: string;
  provider: "github";
  status: AccountStatus;
  createdAt: string;
};

/** Composio sends the browser here after connecting; it forwards to the app. */
export const callbackUrl = (config: Config) => `${config.PUBLIC_API_URL.replace(/\/+$/, "")}/v1/connectors/github/callback`;

export function requireClient(client: ConnectorClient | null): ConnectorClient {
  if (!client) throw new HttpError(503, "CONNECTOR_UNAVAILABLE", "Connected accounts are not configured on the server (COMPOSIO_API_KEY).");
  return client;
}

export async function listConnectors(client: ConnectorClient | null, userId: string): Promise<ConnectorView[]> {
  if (!client) return [];
  const accounts = await client.accounts(userId, GITHUB_TOOLKIT);
  return accounts.map((a) => ({ id: a.id, provider: "github", status: a.status, createdAt: a.createdAt }));
}

/** A link to connect GitHub. A broken earlier connection is removed first so it can be replaced. */
export async function connectGitHub(client: ConnectorClient, config: Config, userId: string): Promise<string> {
  const accounts = await client.accounts(userId, GITHUB_TOOLKIT);
  if (accounts.some((a) => a.status === "active")) {
    throw new HttpError(409, "ALREADY_CONNECTED", "GitHub is already connected. Disconnect it first to switch accounts.");
  }
  await Promise.all(accounts.map((a) => client.disconnect(a.id)));
  return client.connectLink(userId, GITHUB_TOOLKIT, callbackUrl(config));
}

export async function disconnect(client: ConnectorClient, userId: string, connectorId: string): Promise<void> {
  const accounts = await client.accounts(userId, GITHUB_TOOLKIT);
  if (!accounts.some((a) => a.id === connectorId)) throw new HttpError(404, "NOT_FOUND", "Connector not found.");
  await client.disconnect(connectorId);
}
