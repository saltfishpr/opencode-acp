import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { CatalogSchema, type Catalog } from "../acp/catalog.js";
import type { AgentConfig } from "../config.js";
import { logWarn } from "../log.js";

const CatalogCacheSchema = z.object({
  configFingerprint: z.string(),
  catalog: CatalogSchema,
});

type CatalogCache = z.infer<typeof CatalogCacheSchema>;

/**
 * Loads the catalog saved by a previous run so the model picker is populated
 * before the agent finishes starting. Only reuse models from the same launch configuration.
 */
export async function loadCatalog(
  storage: Plugin.Context["storage"],
  agent: AgentConfig,
): Promise<Catalog | undefined> {
  try {
    const result = CatalogCacheSchema.safeParse(await storage.get(catalogKey(agent.id)));
    if (result.success && result.data.configFingerprint === configFingerprint(agent)) return result.data.catalog;
  } catch (error) {
    logWarn("acp", `could not read the cached model catalog: ${message(error)}`);
  }
}

export async function saveCatalog(
  storage: Plugin.Context["storage"],
  agent: AgentConfig,
  catalog: Catalog,
): Promise<void> {
  try {
    const entry: CatalogCache = { configFingerprint: configFingerprint(agent), catalog };
    await storage.set(catalogKey(agent.id), entry);
  } catch (error) {
    logWarn("acp", `could not cache the model catalog: ${message(error)}`);
  }
}

export async function clearCatalog(storage: Plugin.Context["storage"], agentID: string): Promise<void> {
  try {
    await storage.remove(catalogKey(agentID));
  } catch (error) {
    logWarn("acp", `could not remove the cached model catalog: ${message(error)}`);
  }
}

function catalogKey(agentID: string): string {
  return `acp/catalog/by-agent/${agentID}`;
}

function configFingerprint({ command, args, env }: AgentConfig): string {
  const entries = Object.keys(env)
    .sort()
    .map((key) => [key, env[key]]);
  return createHash("sha256")
    .update(JSON.stringify([command, args, entries]))
    .digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
