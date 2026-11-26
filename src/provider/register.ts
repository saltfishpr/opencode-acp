import { Model, Plugin, Provider } from "@opencode/plugin";
import type { PermissionHandler } from "../acp/client.js";
import type { AgentRuntime, AgentState } from "../acp/runtime.js";
import { logWarn } from "../log.js";
import { SessionBindings, sessionDirectory } from "../session/binding.js";
import type { SessionTitles } from "../session/title.js";
import { acpLanguageModel } from "./language.js";

const ADAPTER = "acp";
export const PACKAGE = `aisdk:${ADAPTER}`;

// Keep OpenCode from compacting the remote session before the agent reports its window.
const DEFAULT_CONTEXT_LIMIT = 10_000_000;

interface RegisterOptions {
  readonly agents: ReadonlyMap<string, AgentState>;
  readonly bindings: SessionBindings;
  readonly titles: SessionTitles;
  readonly requestPermission: PermissionHandler;
  readonly onContextWindow: (runtime: AgentRuntime, size: number) => void;
}

export async function registerProviders(ctx: Plugin.Context, options: RegisterOptions) {
  const registered = new Set<string>();
  const occupied = new Set<string>();
  const firstPrompts = new Map<string, string>();

  const language = (info: Model.Info) => {
    if (!registered.has(info.providerID)) return;
    const agent = options.agents.get(info.providerID);
    if (agent === undefined) return;
    const thought = info.settings?.["acpThought"];
    const entry = agent.catalog?.models.find((model) => model.id === info.id);

    return acpLanguageModel(
      {
        model: info.id,
        ...(typeof thought === "string" ? { thought } : {}),
        ...(entry?.defaultThought === undefined ? {} : { defaultThought: entry.defaultThought }),
      },
      {
        runtime: agent.runtime,
        bindings: options.bindings,
        directory: (sessionID) => sessionDirectory(ctx, sessionID),
        titles: options.titles,
        requestPermission: options.requestPermission,
        onTitle: (sessionID, title) => {
          void applyAcpTitle(ctx, sessionID, title, firstPrompts.get(sessionID));
        },
        onContextWindow: (size) => options.onContextWindow(agent.runtime, size),
      },
    );
  };

  const registrations = await Promise.all([
    ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text.trim();
      if (text.length === 0 || firstPrompts.has(event.sessionID)) return;

      firstPrompts.set(event.sessionID, text.slice(0, 60));
      if (firstPrompts.size > 500) {
        const oldest = firstPrompts.keys().next().value;
        if (oldest !== undefined) firstPrompts.delete(oldest);
      }
    }),
    ctx.provider.transform((editor) => {
      registered.clear();
      occupied.clear();
      for (const { provider } of editor.list()) {
        if (provider.package !== PACKAGE) occupied.add(provider.id);
      }
      for (const [agentID, agent] of options.agents) {
        const id = Provider.ID.make(agentID);
        const existing = editor.get(id);
        if (existing !== undefined && existing.provider.package !== PACKAGE) continue;

        const info = { ...Provider.Info.empty(id), name: agent.name, activation: "enabled" as const, package: PACKAGE };
        const limit = agent.runtime.status.contextWindow ?? DEFAULT_CONTEXT_LIMIT;
        const supportsImages = agent.runtime.status.supportsImages === true;
        const models = (agent.catalog?.models ?? []).map((entry) => {
          const defaults = Model.Info.default(id, Model.ID.make(entry.id));
          return {
            ...defaults,
            name: entry.name,
            limit: { context: limit, output: 32_000 },
            capabilities: {
              ...defaults.capabilities,
              input: supportsImages ? ["text", "image"] : ["text"],
            },
            // OpenCode reserves "default" for using the agent's own default level.
            variants: entry.thoughts.flatMap((thought) => {
              if (thought.value === "default") return [];
              return [{ id: Model.VariantID.make(thought.value), settings: { acpThought: thought.value } }];
            }),
          };
        });

        if (existing === undefined) editor.add({ info, models });
        else {
          editor.update(id, (provider) => {
            provider.name = info.name;
          });
          editor.models.set(id, models);
        }
        registered.add(id);
      }
    }),
    ctx.aisdk.hook("sdk", (event) => {
      if ((event.package !== ADAPTER && event.package !== PACKAGE) || !registered.has(event.model.providerID)) return;
      event.sdk = { languageModel: () => language(event.model) };
    }),
    ctx.aisdk.hook("language", (event) => {
      const model = language(event.model);
      if (model !== undefined) event.language = model;
    }),
    ctx.session.hook("title", (event) => {
      if (event.model === undefined || !registered.has(event.model.providerID)) return;
      const title = options.titles.get(event.sessionID) ?? firstPrompts.get(event.sessionID);
      if (title !== undefined) event.result = title;
    }),
  ]);
  return { registrations, occupied };
}

/** Only an untitled session or the first-prompt fallback may be replaced. */
async function applyAcpTitle(ctx: Plugin.Context, sessionID: string, title: string, fallback: string | undefined) {
  try {
    const session = await ctx.session.get({ sessionID });
    if (session.title !== undefined && session.title !== fallback) return;
    await ctx.session.update({ sessionID, title });
  } catch (error) {
    logWarn("acp", `could not apply ACP title: ${error instanceof Error ? error.message : String(error)}`);
  }
}
