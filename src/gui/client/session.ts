import type { MountedSession } from "@opencode/plugin/gui";
import { PACKAGE } from "../../provider/constants.js";

/**
 * The provider id when the session's committed model is served by a configured
 * ACP agent. The composer's unsent selection is not part of the session yet, so
 * ACP features appear after the first ACP prompt commits the model.
 */
export function acpProviderID(session: MountedSession): string | undefined {
  const data = session.server.data;

  let providerID: string | undefined;
  try {
    providerID = data.session.get(session.id)?.model?.providerID;
  } catch {
    return undefined;
  }
  if (providerID === undefined) return undefined;

  const provider = data.location.provider
    .list({ directory: session.directory })
    ?.find((item) => item.id === providerID && item.package === PACKAGE);
  return provider === undefined ? undefined : providerID;
}

export function isAcpSession(session: MountedSession): boolean {
  return acpProviderID(session) !== undefined;
}
