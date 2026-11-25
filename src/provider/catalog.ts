import type { Plugin } from "@opencode/plugin"
import type { Catalog, CatalogModel, CatalogThought } from "../acp/catalog.js"
import type { AgentRuntime } from "../acp/runtime.js"
import { logInfo, logWarn } from "../log.js"

/**
 * Catalog currently advertised for each agent.
 *
 * Lives outside the registration closure so a provider reload, and a plugin
 * hot reload that leaves an older hook active, both read the same list.
 */
const catalogs = new Map<string, Catalog>()

/** Agent IDs with a discovery request in flight. */
const discovering = new Set<string>()

/** Latest catalog for an agent, if discovery or the cache produced one. */
export function catalogOf(agentID: string): Catalog | undefined {
  return catalogs.get(agentID)
}

/**
 * Loads the catalog saved by a previous run so the model picker is populated
 * before the agent finishes starting. Invalid or absent entries are ignored.
 */
export async function seedCatalog(
  ctx: Plugin.Context,
  agentID: string,
): Promise<Catalog | undefined> {
  const current = catalogs.get(agentID)
  if (current !== undefined) return current

  let stored: unknown
  try {
    stored = await ctx.storage.get(key(agentID))
  } catch (error) {
    logWarn("acp", `could not read the cached model catalog for ${agentID}: ${message(error)}`)
    return undefined
  }

  const catalog = parseCatalog(stored)
  if (catalog !== undefined) catalogs.set(agentID, catalog)
  return catalog
}

/**
 * Asks the agent for its model and thinking-level list, saves it, and reloads
 * the provider when the list differs from what was already registered.
 *
 * The agent's model list is only available from a session, so this starts one
 * short-lived session in the server's working directory and closes it again.
 */
export async function refreshCatalog(ctx: Plugin.Context, runtime: AgentRuntime): Promise<void> {
  const agentID = runtime.agent.id
  if (discovering.has(agentID)) return
  discovering.add(agentID)

  try {
    const client = await runtime.ensureClient()
    const next = await client.discoverModels(process.cwd())
    if (next.models.length === 0) {
      logWarn("acp", `${agentID} did not report any models`)
      return
    }

    const previous = catalogs.get(agentID)
    catalogs.set(agentID, next)
    await saveCatalog(ctx, agentID, next)

    if (JSON.stringify(previous) === JSON.stringify(next)) return

    logInfo("acp", `${agentID} offers ${next.models.length} models`)
    try {
      await ctx.provider.reload()
    } catch (error) {
      logWarn("acp", `provider reload after model discovery failed: ${message(error)}`)
    }
  } catch (error) {
    logWarn("acp", `model discovery for ${agentID} failed: ${message(error)}`)
  } finally {
    discovering.delete(agentID)
  }
}

async function saveCatalog(ctx: Plugin.Context, agentID: string, catalog: Catalog): Promise<void> {
  try {
    await ctx.storage.set(key(agentID), catalog)
  } catch (error) {
    logWarn("acp", `could not cache the model catalog for ${agentID}: ${message(error)}`)
  }
}

function key(agentID: string): string {
  return `acp/catalog/${agentID}`
}

/** Accepts only the shape this module writes; anything else is treated as absent. */
function parseCatalog(value: unknown): Catalog | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const models = entry["models"]
  if (!Array.isArray(models)) return undefined

  const parsed: CatalogModel[] = []
  for (const item of models) {
    if (item === null || typeof item !== "object") return undefined
    const model = item as Record<string, unknown>
    const id = model["id"]
    const name = model["name"]
    const thoughts = model["thoughts"]
    if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(thoughts)) return undefined

    const levels: CatalogThought[] = []
    for (const thought of thoughts) {
      if (thought === null || typeof thought !== "object") return undefined
      const level = thought as Record<string, unknown>
      if (typeof level["value"] !== "string" || typeof level["name"] !== "string") return undefined
      levels.push({ value: level["value"], name: level["name"] })
    }

    parsed.push({
      id,
      name,
      ...(typeof model["description"] === "string" ? { description: model["description"] } : {}),
      thoughts: levels,
      ...(typeof model["defaultThought"] === "string"
        ? { defaultThought: model["defaultThought"] }
        : {}),
    })
  }

  const defaultModel = entry["defaultModel"]
  return {
    models: parsed,
    ...(typeof defaultModel === "string" ? { defaultModel } : {}),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
