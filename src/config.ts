import type { LogLevel } from "./log.js"

export const PLUGIN_ID = "opencode-acp"

/**
 * One ACP agent this plugin exposes as an OpenCode provider.
 *
 * `id` becomes the provider ID, so it must be lowercase and stable: sessions and
 * model selections are persisted against it.
 */
export interface AgentConfig {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly enabled: boolean
  /** False for presets whose adapter is not shipped yet; they stay registered but hidden. */
  readonly implemented: boolean
}

export interface Config {
  readonly agents: readonly AgentConfig[]
  readonly errors: readonly string[]
  readonly logLevel: LogLevel
  /** Overrides the context window advertised to OpenCode; learned from ACP when omitted. */
  readonly contextLimit: number | undefined
}

/**
 * CLIs this plugin knows how to launch. They are only detected, never installed;
 * a missing executable is reported at startup and the agent stays unavailable.
 *
 * `acp-codex` is a registered preset so its configuration shape is stable, but
 * the Codex adapter is not implemented yet. It is never spawned or offered as a model.
 */
export const PRESETS: readonly AgentConfig[] = [
  {
    id: "acp-agy",
    name: "Antigravity",
    command: "agy",
    args: ["acp"],
    env: {},
    enabled: true,
    implemented: true,
  },
  {
    id: "acp-codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    env: {},
    enabled: true,
    implemented: false,
  },
]

const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"]

const ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Parses plugin options. Invalid agent entries are reported in `errors` and
 * skipped; a missing `agents` option falls back to the built-in presets.
 */
export function readConfig(raw: Readonly<Record<string, unknown>> | undefined): Config {
  const errors: string[] = []
  const logLevel = readLogLevel(raw?.["logLevel"], errors)
  const contextLimit = readContextLimit(raw?.["contextLimit"], errors)
  const input = raw?.["agents"]

  if (input === undefined) return { agents: PRESETS, errors, logLevel, contextLimit }
  if (!Array.isArray(input)) {
    return {
      agents: PRESETS,
      errors: [...errors, "options.agents must be an array"],
      logLevel,
      contextLimit,
    }
  }

  const agents: AgentConfig[] = []
  for (const [index, value] of input.entries()) {
    if (typeof value !== "object" || value === null) {
      errors.push(`options.agents[${index}] must be an object`)
      continue
    }

    const entry = value as Record<string, unknown>
    const id = entry["id"]
    const command = entry["command"]

    if (typeof id !== "string" || !ID.test(id)) {
      errors.push(`options.agents[${index}].id must match ${ID}`)
      continue
    }

    const preset = PRESETS.find((item) => item.id === id)

    if (command !== undefined && typeof command !== "string") {
      errors.push(`options.agents[${index}].command must be a string`)
      continue
    }

    const resolvedCommand = command ?? preset?.command
    if (resolvedCommand === undefined) {
      errors.push(`options.agents[${index}].command is required for a custom agent`)
      continue
    }

    const args = entry["args"] ?? preset?.args ?? []
    const env = entry["env"] ?? preset?.env ?? {}
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      errors.push(`options.agents[${index}].args must be a string array`)
      continue
    }
    if (typeof env !== "object" || env === null || Object.values(env).some((item) => typeof item !== "string")) {
      errors.push(`options.agents[${index}].env must be a string map`)
      continue
    }

    agents.push({
      id,
      name: typeof entry["name"] === "string" ? entry["name"] : (preset?.name ?? id),
      command: resolvedCommand,
      args: args as string[],
      env: env as Record<string, string>,
      enabled: entry["enabled"] !== false,
      implemented: preset?.implemented ?? true,
    })
  }

  return { agents, errors, logLevel, contextLimit }
}

function readLogLevel(value: unknown, errors: string[]): LogLevel {
  if (value === undefined) return "info"
  if (typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel
  }

  errors.push(`options.logLevel must be one of ${LOG_LEVELS.join(", ")}`)
  return "info"
}

function readContextLimit(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value

  errors.push("options.contextLimit must be a positive integer")
  return undefined
}
