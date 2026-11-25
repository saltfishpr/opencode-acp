import { Model, Plugin, Provider } from "@opencode/plugin"
import type { AgentConfig } from "../config.js"
import type { AgentRuntime } from "../acp/runtime.js"
import { logWarn } from "../log.js"
import { SessionBindings, sessionDirectory } from "../session/binding.js"
import type { SessionTitles } from "../session/title.js"
import { acpLanguageModel } from "./language.js"

/**
 * `aisdk:` makes core route the model through the AI SDK seam; the suffix is
 * only an identifier because the `sdk` hook supplies the implementation.
 */
export const PACKAGE = "aisdk:acp"

/**
 * Used until an ACP agent reports its real window, and when it never does.
 * Large enough that OpenCode does not compact a remote agent's context.
 */
export const DEFAULT_CONTEXT_LIMIT = 10_000_000

/** How the agent was found at startup; drives provider visibility. */
export type AgentAvailability = "ready" | "missing" | "disabled" | "deferred"

/** A registration whose hook can be removed when the plugin reloads. */
export interface Disposable {
  dispose(): Promise<void>
}

/**
 * The title request arrives wrapped in a generated instruction, so the real
 * first prompt is captured on admission instead. ACP `session_info_update`
 * titles take precedence when the agent reports one.
 */
const firstPrompt = new Map<string, string>()

/**
 * Context window currently written into each agent's model catalog.
 *
 * Plugin hot reload can leave the previous instance's language hook active for
 * a while. That hook must still notice a model catalog that was rebuilt with
 * the default window, so the "already applied" check is shared across instances
 * instead of living in one hook's closure.
 */
const appliedContexts = new Map<string, number>()

/** Registered once per plugin instance, not per agent. */
export async function captureFirstPrompts(ctx: Plugin.Context): Promise<Disposable> {
  return ctx.session.hook("prompt", (event) => {
    const text = event.prompt.text.trim()
    if (text.length === 0 || firstPrompt.has(event.sessionID)) return

    firstPrompt.set(event.sessionID, text.slice(0, 60))
    if (firstPrompt.size > 500) {
      const oldest = firstPrompt.keys().next().value
      if (oldest !== undefined) firstPrompt.delete(oldest)
    }
  })
}

interface RegisterOptions {
  readonly runtime: AgentRuntime
  readonly bindings: SessionBindings
  /** ACP titles reported by the agent, used before the first-prompt fallback. */
  readonly titles: SessionTitles
  readonly availability: AgentAvailability
  /** Configured context window override; ACP-reported size wins only when absent. */
  readonly contextLimit: number | undefined
}

/**
 * Registers the provider, its models and the hooks that route requests to the
 * ACP client.
 *
 * A missing or deferred agent stays registered so the GUI and diagnostics can
 * describe it, but its provider is disabled.
 */
export async function registerAgent(
  ctx: Plugin.Context,
  agent: AgentConfig,
  options: RegisterOptions,
): Promise<readonly Disposable[]> {
  const id = Provider.ID.make(agent.id)
  const registrations: Disposable[] = []
  const real = options.availability === "ready"
  const models = () => {
    const limit = options.contextLimit ?? options.runtime.status.contextWindow ?? DEFAULT_CONTEXT_LIMIT
    const list = []

    if (real) {
      list.push({
        ...Model.Info.default(id, Model.ID.make("default")),
        name: agent.name,
        limit: { context: limit, output: 32_000 },
      })
    }

    appliedContexts.set(agent.id, limit)
    return list
  }

  registrations.push(
    await ctx.provider.transform((editor) => {
      const info = {
        ...Provider.Info.empty(id),
        name: agent.name,
        activation: real ? ("enabled" as const) : ("disabled" as const),
        package: PACKAGE,
      }
      const list = models()

      if (editor.get(id) === undefined) editor.add({ info, models: list })
      else {
        editor.update(id, (provider) => {
          provider.name = info.name
          provider.activation = info.activation
          provider.package = PACKAGE
        })
        editor.models.set(id, list)
      }
    }),
  )

  let reloadTimer: ReturnType<typeof setTimeout> | undefined

  const model = (modelID: string) =>
    acpLanguageModel(modelID, {
      runtime: options.runtime,
      bindings: options.bindings,
      directory: (sessionID) => sessionDirectory(ctx, sessionID),
      titles: options.titles,
      onTitle: (sessionID, title) => {
        void applyAcpTitle(ctx, sessionID, title)
      },
      onContextWindow: (size) => {
        if (options.contextLimit !== undefined || appliedContexts.get(agent.id) === size) return
        appliedContexts.set(agent.id, size)
        if (reloadTimer !== undefined) return

        // Reload once after the first turn so the model catalog shows the
        // window the agent actually reported.
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined
          void ctx.provider.reload().catch((error: unknown) => {
            logWarn("acp", `provider reload after context update failed: ${message(error)}`)
          })
        }, 0)
        reloadTimer.unref?.()
      },
    })

  registrations.push(
    await ctx.aisdk.hook("sdk", (event) => {
      event.sdk = { languageModel: (modelID: string) => model(modelID) }
    }, { providerID: id }),
  )

  registrations.push(
    await ctx.aisdk.hook("language", (event) => {
      event.language = model(event.model.id)
    }, { providerID: id }),
  )

  registrations.push(
    await ctx.session.hook(
      "title",
      (event) => {
        const title = options.titles.get(event.sessionID) ?? firstPrompt.get(event.sessionID)
        if (title !== undefined) event.result = title
      },
      { providerID: id },
    ),
  )

  return registrations
}

/**
 * Applies an ACP title that arrived after OpenCode generated one.
 *
 * A user rename is kept; only an untitled session or the first-prompt fallback
 * is replaced, so the remote agent's title does not overwrite a deliberate
 * local name.
 */
async function applyAcpTitle(ctx: Plugin.Context, sessionID: string, title: string): Promise<void> {
  try {
    const session = await ctx.session.get({ sessionID })
    const fallback = firstPrompt.get(sessionID)
    if (session.title !== undefined && session.title !== fallback) return
    await ctx.session.update({ sessionID, title })
  } catch (error) {
    logWarn("acp", `could not apply ACP title: ${message(error)}`)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
