import { HttpError } from "../../lib/errors.js";
import {
  type DataSource,
  type GitHubDataSource,
  type NewsDataSource,
  type WebsiteDataSource,
} from "../../spec/widget-spec.js";
import { type ConnectionStatus, type ConnectorRuntimeContext, type DataConnectorTemplate } from "./data-connector.js";
import { GITHUB_TOOLKIT, runQuery, sampleData, type SourceData } from "./github.js";
import { connectorHttpError, requireClient } from "./service.js";
import { fetchNewsFeed } from "../widget-data/news.js";
import { fetchWebsitePage } from "../widget-data/website.js";

const connectors: {
  github: DataConnectorTemplate<GitHubDataSource>;
  website: DataConnectorTemplate<WebsiteDataSource>;
  news: DataConnectorTemplate<NewsDataSource>;
} = {
  github: {
    async connectionStatus(context) {
      if (!context.client) return "not_configured";
      const accounts = await context.client.accounts(context.userId, GITHUB_TOOLKIT);
      if (accounts.some((account) => account.status === "active")) return "connected";
      return accounts.length > 0 ? "needs_reauth" : "not_connected";
    },
    requireConnection(status) {
      if (status === "not_configured") {
        throw new HttpError(503, "CONNECTOR_UNAVAILABLE", "Connected accounts are not configured on the server (COMPOSIO_API_KEY).");
      }
      if (status === "not_connected") {
        throw new HttpError(409, "CONNECTOR_REQUIRED", "Connect GitHub to load this widget's data.");
      }
      if (status === "needs_reauth") {
        throw new HttpError(409, "CONNECTOR_NEEDS_REAUTH", "Reconnect GitHub to keep this widget updated.");
      }
    },
    fetch(source, context) {
      return runQuery(requireClient(context.client), context.userId, source.query);
    },
    sample: (source) => sampleData(source.query),
  },
  website: {
    fetch(source, context) {
      return fetchWebsitePage(source.url, { imageIndexes: context.imageIndexes });
    },
  },
  news: {
    fetch(source, context) {
      return fetchNewsFeed(source.url, { imageIndexes: context.imageIndexes });
    },
  },
};

export async function connectorConnectionStatus(
  source: DataSource,
  context: ConnectorRuntimeContext,
): Promise<ConnectionStatus> {
  if (source.connector === "github") return await connectors.github.connectionStatus?.(context) ?? "connected";
  return "connected";
}

export async function fetchConnectorData(
  source: DataSource,
  context: ConnectorRuntimeContext,
): Promise<SourceData> {
  switch (source.connector) {
    case "github":
      return connectors.github.fetch(source, context);
    case "website":
      return connectors.website.fetch(source, context);
    case "news":
      return connectors.news.fetch(source, context);
  }
}

export function sampleConnectorData(source: DataSource): SourceData | null {
  if (source.connector === "github") return connectors.github.sample?.(source) ?? null;
  return null;
}

export function requireConnectorConnection(source: DataSource, status: ConnectionStatus): void {
  switch (source.connector) {
    case "github":
      connectors.github.requireConnection?.(status);
      return;
    case "website":
      connectors.website.requireConnection?.(status);
      return;
    case "news":
      connectors.news.requireConnection?.(status);
      return;
  }
}

export function connectorError(error: unknown): HttpError | null {
  return connectorHttpError(error);
}
