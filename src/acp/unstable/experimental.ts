import type { AcpClient } from "../client/client.js";
import type {
  ExperimentalApi,
  ForkSessionOptions,
  SessionOptionsQuery,
} from "../types/public.js";

export function createExperimentalApi(client: AcpClient): ExperimentalApi {
  return {
    protocol: "unstable",
    forkSession: (options: ForkSessionOptions) => client.forkSessionUnstable(options),
    getSessionStatus: (sessionId) => client.getSessionStatusUnstable(sessionId),
    getSessionOptions: (options: SessionOptionsQuery) =>
      client.getSessionOptionsUnstable(options),
    setSessionTitle: (sessionId, title) =>
      client.setSessionTitleUnstable(sessionId, title),
  };
}
