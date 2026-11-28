import type { SessionCapabilities as UnstableSessionCapabilities } from "@agentclientprotocol/sdk/unstable";
import type {
  AgentCapabilities,
  ClientCapabilities,
  McpServer,
  SystemPrompt,
} from "@agentclientprotocol/sdk";

import {
  AcpInvalidArgumentError,
  AcpInvalidHostError,
  AcpUnsupportedCapabilityError,
} from "./errors.js";
import type { AcpHost } from "./types/public.js";

export interface ClientCapabilityOptions {
  host?: AcpHost;
  capabilitiesMeta?: Record<string, unknown>;
}

export function validateHost(host?: AcpHost): void {
  if (!host?.terminal) {
    return;
  }

  const missing = (["create", "output", "waitForExit", "kill", "release"] as const).filter(
    (method) => typeof host.terminal?.[method] !== "function",
  );
  if (missing.length > 0) {
    throw new AcpInvalidHostError(
      `host.terminal must provide all five methods; missing: ${missing.join(", ")}`,
    );
  }
}

export function buildClientCapabilities(
  options: ClientCapabilityOptions,
): ClientCapabilities {
  const host = options.host;
  const capabilities: ClientCapabilities = {
    session: {
      configOptions: { boolean: {} },
      compaction: {},
    },
    plan: {},
    subagents: {},
  };

  if (host?.fs?.readTextFile || host?.fs?.writeTextFile) {
    capabilities.fs = {
      ...(host.fs.readTextFile ? { readTextFile: true } : {}),
      ...(host.fs.writeTextFile ? { writeTextFile: true } : {}),
    };
  }

  if (host?.terminal) {
    capabilities.terminal = true;
  }

  if (host?.terminalAuth) {
    capabilities.auth = { terminal: true };
  }

  if (host?.notice) {
    capabilities.session = {
      ...capabilities.session,
      notices: {},
    };
  }

  if (host?.elicitation?.create) {
    const modes = host.elicitation.modes ?? ["form", "url"];
    const elicitation: NonNullable<ClientCapabilities["elicitation"]> = {};
    if (modes.includes("form")) {
      elicitation.form = {};
    }
    if (modes.includes("url")) {
      elicitation.url = {};
    }
    if (elicitation.form || elicitation.url) {
      capabilities.elicitation = elicitation;
    }
  }

  if (options.capabilitiesMeta) {
    capabilities._meta = options.capabilitiesMeta;
  }

  return capabilities;
}

export function hasMcpCapability(
  capabilities: AgentCapabilities | null,
  server: McpServer,
): boolean {
  if (!("type" in server)) {
    return true;
  }
  if (server.type === "http") {
    return capabilities?.mcpCapabilities?.http === true;
  }
  if (server.type === "sse") {
    return capabilities?.mcpCapabilities?.sse === true;
  }
  return false;
}

export function assertMcpServersSupported(
  capabilities: AgentCapabilities | null,
  servers: readonly McpServer[],
): void {
  for (const server of servers) {
    if (!hasMcpCapability(capabilities, server)) {
      const type = "type" in server ? server.type : "stdio";
      throw new AcpUnsupportedCapabilityError(`mcpCapabilities.${type}`);
    }
  }
}

export function assertAdditionalDirectoriesSupported(
  capabilities: AgentCapabilities | null,
  directories: readonly string[] | undefined,
): void {
  if (directories && directories.length > 0) {
    if (!capabilities?.sessionCapabilities?.additionalDirectories) {
      throw new AcpUnsupportedCapabilityError(
        "sessionCapabilities.additionalDirectories",
      );
    }
  }
}

export function assertSystemPromptSupported(
  capabilities: AgentCapabilities | null,
  systemPrompt: SystemPrompt | undefined,
): void {
  if (!systemPrompt) {
    return;
  }
  const support = capabilities?.sessionCapabilities?.systemPrompt;
  if (!support) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.systemPrompt");
  }
  if (systemPrompt.mode === "override" && !support.mode?.override) {
    throw new AcpUnsupportedCapabilityError(
      "sessionCapabilities.systemPrompt.mode.override",
    );
  }
  if (systemPrompt.mode !== "append" && systemPrompt.mode !== "override") {
    throw new AcpInvalidArgumentError(
      `Unsupported system prompt mode "${systemPrompt.mode}"`,
    );
  }
}

export function assertLoadSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  if (!capabilities?.loadSession) {
    throw new AcpUnsupportedCapabilityError("loadSession");
  }
}

export function assertListSessionsSupported(
  capabilities: AgentCapabilities | null,
): void {
  if (!capabilities?.sessionCapabilities?.list) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.list");
  }
}

export function assertDeleteSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  if (!capabilities?.sessionCapabilities?.delete) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.delete");
  }
}

export function assertResumeSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  if (!capabilities?.sessionCapabilities?.resume) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.resume");
  }
}

export function assertCloseSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  if (!capabilities?.sessionCapabilities?.close) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.close");
  }
}

export function assertForkSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (!sessionCapabilities?.fork) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.fork");
  }
}

export function assertSessionStatusSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (!sessionCapabilities?.status) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.status");
  }
}

export function assertSessionOptionsSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (!sessionCapabilities?.options) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.options");
  }
}

export function assertSessionOptionsSessionSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (
    !capabilities?.loadSession &&
    !sessionCapabilities?.resume &&
    !sessionCapabilities?.fork
  ) {
    throw new AcpUnsupportedCapabilityError(
      "loadSession, sessionCapabilities.resume, or sessionCapabilities.fork",
    );
  }
}

export function assertSessionTitleSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (!sessionCapabilities?.title) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.title");
  }
}

export function assertInitialConfigOptionsSupported(
  capabilities: AgentCapabilities | null,
): void {
  const sessionCapabilities = capabilities?.sessionCapabilities as
    | UnstableSessionCapabilities
    | undefined;
  if (!sessionCapabilities?.options) {
    throw new AcpUnsupportedCapabilityError("sessionCapabilities.options");
  }
}
