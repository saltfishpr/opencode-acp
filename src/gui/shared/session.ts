import type { MountedSession } from "@opencode/plugin/gui";

/** The package a provider uses when it is backed by this plugin. */
export const ACP_PACKAGE = "aisdk:acp";

/** The subset of `metadata.acp` the GUI reads; the server writes the same keys. */
export interface AcpSessionMeta {
  readonly agent: string;
  readonly session: string;
  readonly cwd?: string;
  readonly updatedAt?: string;
}

/** Reads `metadata.acp` from the loaded session, if the server bound it to an ACP session. */
export function acpMetadataOf(session: MountedSession): AcpSessionMeta | undefined {
  let metadata: unknown;
  try {
    metadata = session.server.data.session.get(session.id)?.metadata;
  } catch {
    return undefined;
  }

  const acp = isRecord(metadata) ? metadata["acp"] : undefined;
  if (!isRecord(acp)) return undefined;

  const agent = text(acp["agent"]);
  const acpSession = text(acp["session"]);
  if (agent === undefined || acpSession === undefined) return undefined;

  const cwd = text(acp["cwd"]);
  const updatedAt = text(acp["updatedAt"]);
  return {
    agent,
    session: acpSession,
    ...(cwd === undefined ? {} : { cwd }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/**
 * The ACP provider a session uses. A bound session answers from `metadata.acp`;
 * an unbound one answers from its committed model when the provider's package
 * is this plugin. The composer's unsent model selection is not considered.
 */
export function acpProviderID(session: MountedSession): string | undefined {
  let providerID: string | undefined;
  try {
    providerID = session.server.data.session.get(session.id)?.model?.providerID;
  } catch {
    return undefined;
  }

  const metadata = acpMetadataOf(session);
  if (metadata !== undefined) return metadata.agent;
  if (providerID === undefined) return undefined;

  const provider = session.server.data.location.provider
    .list({ directory: session.directory })
    ?.find((item) => item.id === providerID && item.package === ACP_PACKAGE);
  return provider === undefined ? undefined : providerID;
}

export function isAcpSession(session: MountedSession): boolean {
  return acpProviderID(session) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
