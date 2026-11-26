import { Plugin } from "@opencode/plugin"
import { AgentRuntime } from "./acp/runtime.js"
import { PLUGIN_ID, readConfig } from "./config.js"
import { diagnosticsOf, findExecutable, statusOf } from "./diagnostics.js"
import { PermissionBroker } from "./interaction/permission.js"
import { setLogLevel, logInfo, logWarn } from "./log.js"
import { captureFirstPrompts, registerAgent, type Disposable } from "./provider/register.js"
import { AcpSettings } from "./rpc.js"
import { SessionBindings } from "./session/binding.js"
import { SessionTitles } from "./session/title.js"

/** Live agent processes, killed when the plugin unloads or the server exits. */
const active = new Set<AgentRuntime>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true

  process.on("exit", () => {
    for (const runtime of active) runtime.close()
  })
}

/**
 * Exposes external ACP agents as OpenCode providers.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const { agents, errors, logLevel, contextLimit } = readConfig(ctx.options)
    setLogLevel(logLevel)

    for (const error of errors) logWarn("acp", error)

    const disposables: Disposable[] = []
    disposables.push(await captureFirstPrompts(ctx))

    const bindings = new SessionBindings(ctx.storage)
    const permissions = new PermissionBroker(ctx)
    const titles = new SessionTitles()
    const runtimes = new Map<string, AgentRuntime>()

    const rpc = await ctx.rpc.register(AcpSettings, {
      async read() {
        return diagnosticsOf({ agents, runtimes, logLevel, contextLimit })
      },
    })

    for (const agent of agents) {
      const path = findExecutable(agent.command, agent.env["PATH"] ?? process.env["PATH"] ?? "")
      const availability = statusOf(agent, path)
      const proxy = ["HTTPS_PROXY", "HTTP_PROXY"].filter((key) => agent.env[key] !== undefined)
      logInfo(
        "acp",
        `configured ${agent.id}: ${[agent.command, ...agent.args].join(" ")} ` +
          `(${availability}${path === "" ? "" : ` at ${path}`}) ` +
          `proxy=${proxy.length === 0 ? "none" : proxy.join(",")}`,
      )

      if (!agent.enabled) continue

      const runtime = new AgentRuntime(agent, {
        requestPermission: (params, turn) => permissions.request(params, turn),
      })
      runtimes.set(agent.id, runtime)
      active.add(runtime)

      await registerAgent(ctx, agent, {
        runtime,
        bindings,
        titles,
        availability,
        contextLimit,
      }).then((registrations) => disposables.push(...registrations))
    }

    const proxy = ["HTTPS_PROXY", "HTTP_PROXY"].filter((key) => process.env[key] !== undefined)
    logInfo(
      "acp",
      `startup diagnostics: cwd=${process.cwd()} serverProxy=${proxy.length === 0 ? "none" : proxy.join(",")} ` +
        `contextLimit=${contextLimit ?? "learn-from-acp"} logLevel=${logLevel}`,
    )
    installExitHook()

    return async () => {
      await Promise.all(
        disposables.map((item) =>
          item.dispose().catch((error: unknown) => logWarn("acp", `hook cleanup failed: ${message(error)}`)),
        ),
      )
      await rpc.dispose()
      permissions.close()
      titles.clear()
      for (const runtime of runtimes.values()) {
        active.delete(runtime)
        runtime.close()
      }
    }
  },
})

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
