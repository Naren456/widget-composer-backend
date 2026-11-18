import { type DataSource } from "../../spec/widget-spec.js";
import { type GitHubApi } from "./connector.js";
import { type SourceData } from "./github.js";

export type ConnectorRuntimeContext = {
  userId: string;
  github: GitHubApi;
  imageIndexes: number[];
};

export type ConnectionStatus = "connected" | "not_configured" | "not_connected" | "needs_reauth";

/** Shared contract for every server-side data connector adapter. */
export type DataConnectorTemplate<TSource extends DataSource> = {
  fetch(source: TSource, context: ConnectorRuntimeContext): Promise<SourceData>;
  connectionStatus?(context: ConnectorRuntimeContext, source: TSource): Promise<ConnectionStatus>;
  requireConnection?(status: ConnectionStatus): void;
  sample?(source: TSource): SourceData;
};
