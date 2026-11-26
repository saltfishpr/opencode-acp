import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import { PLUGIN_ID, type AgentConfig } from "./config.js"
import { describeExit } from "./acp/errors.js"
import type { AgentRuntime } from "./acp/runtime.js"
import { catalogOf } from "./provider/catalog.js"
import { DEFAULT_CONTEXT_LIMIT, type AgentAvailability } from "./provider/register.js"

const exec = promisify(execFile)

/** What one configured agent looks like to the settings page. */
export interface AgentDiagnostics {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly enabled: boolean
  readonly installed: boolean
  readonly path: string
  readonly version: string
  readonly status: AgentAvailability
  readonly note: string
  readonly defaultModel: string
  readonly models: readonly string[]
  readonly contextLimit: number
  readonly running: boolean
  readonly pid: number
  readonly lastFailure: string
}

export interface Diagnostics {
  readonly plugin: {
    readonly id: string
    readonly logLevel: string
    readonly contextLimit: number
  }
  readonly agents: readonly AgentDiagnostics[]
}

export interface DiagnosticsInput {
  readonly agents: readonly AgentConfig[]
  readonly runtimes: ReadonlyMap<string, AgentRuntime>
  readonly logLevel: string
  readonly contextLimit: number | undefined
}

/** A resolved executable and its self-reported version, cached briefly per process. */
interface CommandInfo {
  readonly path: string
  readonly version: string
}

const VERSION_TTL_MS = 60_000
const versionCache = new Map<string, { value: CommandInfo; at: number }>()

/**
 * Resolves a configured command against the agent's PATH, then asks it for a
 * version. Detection only: this never installs anything or starts an ACP turn.
 */
export async function inspectCommand(agent: AgentConfig): Promise<CommandInfo> {
  const path = findExecutable(agent.command, agent.env["PATH"] ?? process.env["PATH"] ?? "")
  if (path === "") return { path: "", version: "" }

  const key = `${path}\0${agent.env["PATH"] ?? ""}`
  const cached = versionCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < VERSION_TTL_MS) return cached.value

  const value = { path, version: await versionOf(path, agent.env) }
  versionCache.set(key, { value, at: Date.now() })
  return value
}

/** Builds the settings payload from configuration and live runtime state. */
export async function diagnosticsOf(input: DiagnosticsInput): Promise<Diagnostics> {
  const agents: AgentDiagnostics[] = []

  for (const agent of input.agents) {
    const found = await inspectCommand(agent)
    const status = statusOf(agent, found.path)
    const runtime = input.runtimes.get(agent.id)
    const state = runtime?.status
    const catalog = catalogOf(agent.id)

    agents.push({
      id: agent.id,
      name: agent.name,
      command: agent.command,
      args: [...agent.args],
      enabled: agent.enabled,
      installed: found.path !== "",
      path: found.path,
      version: found.version,
      status,
      note: noteOf(agent, status),
      defaultModel: catalog?.defaultModel === undefined ? "" : `${agent.id}/${catalog.defaultModel}`,
      models: catalog?.models.map((model) => model.id) ?? [],
      contextLimit:
        input.contextLimit ?? runtime?.status.contextWindow ?? DEFAULT_CONTEXT_LIMIT,
      running: state?.running === true,
      pid: state?.pid ?? 0,
      lastFailure: lastFailureOf(runtime),
    })
  }

  return {
    plugin: {
      id: PLUGIN_ID,
      logLevel: input.logLevel,
      contextLimit: input.contextLimit ?? 0,
    },
    agents,
  }
}

/** Finds an executable the way a shell would, without starting it. */
export function findExecutable(command: string, pathValue: string): string {
  if (command.length === 0) return ""

  if (command.includes("/") || command.includes("\\")) {
    const candidate = isAbsolute(command) ? command : resolve(command)
    return isExecutable(candidate) ? candidate : ""
  }

  const extensions =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((item) => item.toLowerCase())
      : [""]

  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue

    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }

  return ""
}

/** Availability from configuration plus whether the executable resolved. */
export function statusOf(agent: AgentConfig, path: string): AgentAvailability {
  if (!agent.enabled) return "disabled"
  return path === "" ? "missing" : "ready"
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function versionOf(path: string, env: Readonly<Record<string, string>>): Promise<string> {
  try {
    const { stdout, stderr } = await exec(path, ["--version"], {
      timeout: 3_000,
      env: { ...process.env, ...env },
    })
    const line = `${stdout}\n${stderr}`
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0)

    return (line ?? "").slice(0, 120)
  } catch {
    return ""
  }
}

function noteOf(agent: AgentConfig, status: AgentAvailability): string {
  if (!agent.enabled) return "已在插件配置中禁用。"
  if (status === "missing") return `未找到 ${agent.command}，请安装对应 CLI 或修改 command。`
  return ""
}

function lastFailureOf(runtime: AgentRuntime | undefined): string {
  if (runtime === undefined) return ""
  const status = runtime.status
  if (status.exit !== undefined && status.failure?.closedByUser !== true) {
    return `进程退出（${describeExit(status.exit)}）`
  }
  return runtime.lastFailure ?? ""
}
