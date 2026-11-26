import { RequestError } from "@agentclientprotocol/sdk";
import { Plugin } from "@opencode/plugin";
import { AcpStartError } from "./acp/errors.js";
import { AgentRuntime, findExecutable, type AgentState } from "./acp/runtime.js";
import {
  EMPTY_CONFIG,
  PLUGIN_ID,
  isLogLevel,
  readConfig,
  sameLaunch,
  type AgentConfig,
  type Config,
} from "./config.js";
import { PermissionBroker } from "./interaction/permission.js";
import { logError, logInfo, logWarn, setLogLevel, type LogLevel } from "./log.js";
import { clearCatalog, loadCatalog, saveCatalog } from "./provider/catalog.js";
import { PACKAGE, registerProviders } from "./provider/register.js";
import {
  AcpSettings,
  AGENT_ID,
  type AgentInput,
  type AgentStatus,
  type MutationResult,
  type SettingsView,
} from "./rpc.js";
import { SessionBindings } from "./session/binding.js";
import { SessionTitles } from "./session/title.js";

// Storage and processes belong to the server; provider registrations belong to each location.
const SETTINGS_KEY = "acp/settings";
const stateKey = Symbol.for("opencode-acp/server-state/v1");
interface ServerState {
  readonly locations: Map<Plugin.Context, ReadonlySet<string>>;
  readonly running: Map<string, AgentState>;
  readonly contextWindows: WeakMap<AgentRuntime, number>;
  readonly onExit: () => void;
  config: Config;
  queue: Promise<void>;
}

// OpenCode can evaluate a separate copy of the plugin module for each location.
const scope = globalThis as typeof globalThis & { [stateKey]?: ServerState };
const state: ServerState = (scope[stateKey] ??= {
  locations: new Map(),
  running: new Map(),
  contextWindows: new WeakMap(),
  onExit: closeAgents,
  config: EMPTY_CONFIG,
  queue: Promise.resolve(),
});
const { locations, running, contextWindows } = state;

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const titles = new SessionTitles();
    const permissions = new PermissionBroker(ctx);
    const { registrations, occupied } = await registerProviders(ctx, {
      agents: running,
      bindings: new SessionBindings(ctx.storage),
      titles,
      requestPermission: (params, turn) => permissions.request(params, turn),
      onContextWindow(runtime, size) {
        if (contextWindows.get(runtime) === size) return;
        contextWindows.set(runtime, size);
        setTimeout(() => {
          if (running.get(runtime.agent.id)?.runtime === runtime) void reloadProviders();
        }, 0).unref();
      },
    });

    try {
      await enqueue(async () => {
        if (locations.size === 0) {
          state.config = readConfig(await ctx.storage.get(SETTINGS_KEY));
          setLogLevel(state.config.logLevel);
          process.on("exit", state.onExit);
          for (const agent of state.config.agents) await startAgent(ctx, agent);
        }
        locations.set(ctx, occupied);
        await reloadProviders([ctx]);
      });
    } catch (error) {
      permissions.close();
      throw error;
    }

    const rpc = await ctx.rpc.register(AcpSettings, {
      async settings() {
        return enqueue(async () => settingsView());
      },
      saveAgent(input) {
        const { revision, create, agent } = input as { revision: number; create: boolean; agent: AgentInput };
        return mutate(revision, async () => {
          const previous = state.config.agents.find((item) => item.id === agent.id);
          if (create && previous !== undefined) return { status: "duplicate", field: "id" };
          if (!create && previous === undefined) return { status: "notFound" };
          if (!AGENT_ID.test(agent.id)) return { status: "invalid", field: "id" };
          if (!agent.name.trim() || agent.name.includes("\0")) return { status: "invalid", field: "name" };
          const command = agent.command.trim();
          if (!command || command.includes("\0")) return { status: "invalid", field: "command" };
          if (agent.args.some((arg) => arg.includes("\0"))) return { status: "invalid", field: "args" };
          if (create) {
            for (const [location, occupied] of locations) {
              const { data } = await location.provider.list();
              if (
                occupied.has(agent.id) ||
                data.some((provider) => provider.id === agent.id && provider.package !== PACKAGE)
              ) {
                return { status: "duplicate", field: "id" };
              }
            }
          }
          const env: Record<string, string> = Object.create(null);
          for (const [key, value] of Object.entries(agent.env)) {
            if (!key || value?.includes("\0")) return { status: "invalid", field: "env" };
            if (value !== null) env[key] = value;
            else {
              const saved = previous?.env[key];
              if (typeof saved !== "string") return { status: "invalid", field: "env" };
              env[key] = saved;
            }
          }
          const next = { ...agent, name: agent.name.trim(), command, env };
          return saveAgent(ctx, agent.id, previous, {
            ...next,
            enabled: previous?.enabled ?? true,
          });
        });
      },
      setEnabled(input) {
        const { revision, id, enabled } = input as { revision: number; id: string; enabled: boolean };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (agent.enabled === enabled) return { status: "ok" };
          return saveAgent(ctx, id, agent, { ...agent, enabled });
        });
      },
      removeAgent(input) {
        const { revision, id } = input as { revision: number; id: string };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          return saveAgent(ctx, id, agent, undefined);
        });
      },
      retryAgent(input) {
        const { revision, id } = input as { revision: number; id: string };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (!agent.enabled) return { status: "conflict" };
          const active = running.get(id);
          if (active?.status === "discovering") return { status: "ok" };
          if (active !== undefined && !active.runtime.pause()) return { status: "busy" };
          stopAgent(id);
          await startAgent(ctx, agent);
          await reloadProviders();
          return { status: "ok" };
        });
      },
      setLogLevel(input) {
        const { revision, logLevel } = input as { revision: number; logLevel: LogLevel };
        return mutate(revision, async () => {
          if (!isLogLevel(logLevel)) return { status: "invalid" };
          if (logLevel !== state.config.logLevel) {
            await persist(ctx, { ...state.config, logLevel });
            setLogLevel(logLevel);
          }
          return { status: "ok" };
        });
      },
    });

    return async () => {
      await rpc.dispose();
      await enqueue(async () => {
        locations.delete(ctx);
        if (locations.size === 0) {
          process.off("exit", state.onExit);
          closeAgents();
        }
      });
      permissions.close();
      titles.clear();
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});

function settingsView(): SettingsView {
  const { config } = state;
  return {
    revision: config.revision,
    logLevel: config.logLevel,
    agents: config.agents.map(({ id, name, command, args, env, enabled }) => {
      const active = running.get(id);
      const exited = active?.runtime.status.exit !== undefined;
      const status: AgentStatus = !enabled
        ? "disabled"
        : active === undefined
          ? "missing"
          : exited
            ? "failed"
            : active.status;
      return {
        id,
        name,
        command,
        args,
        enabled,
        status,
        envKeys: Object.keys(env),
        modelCount: active?.catalog?.models.length ?? 0,
        failure: active?.failure || (exited ? "exited" : ""),
      };
    }),
  };
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const pending = state.queue.then(operation);
  state.queue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

function mutate(revision: number, operation: () => Promise<MutationResult>): Promise<MutationResult> {
  return enqueue(async () => {
    if (revision !== state.config.revision) return { status: "conflict" };
    try {
      return await operation();
    } catch (error) {
      logError("acp", `Could not update settings: ${message(error)}`);
      return { status: "saveFailed" };
    }
  });
}

async function persist(ctx: Plugin.Context, value: Config): Promise<void> {
  const next = { ...value, revision: state.config.revision + 1 };
  await ctx.storage.set(SETTINGS_KEY, {
    ...next,
    agents: next.agents.map((agent) => ({ ...agent, args: [...agent.args], env: { ...agent.env } })),
  });
  state.config = next;
}

async function saveAgent(
  ctx: Plugin.Context,
  id: string,
  previous: AgentConfig | undefined,
  next: AgentConfig | undefined,
): Promise<MutationResult> {
  const active = running.get(id);
  const launchChanged = previous !== undefined && next !== undefined && !sameLaunch(previous, next);
  const restart = launchChanged || previous?.enabled !== next?.enabled;
  if (restart && active !== undefined && !active.runtime.pause()) return { status: "busy" };

  try {
    const agents = state.config.agents.flatMap((agent) =>
      agent.id === id ? (next === undefined ? [] : [next]) : [agent],
    );
    if (previous === undefined && next !== undefined) agents.push(next);
    await persist(ctx, { ...state.config, agents });
  } catch (error) {
    active?.runtime.resume();
    throw error;
  }

  if (restart) {
    stopAgent(id);
    if (next !== undefined) await startAgent(ctx, next);
  } else if (active !== undefined && next !== undefined) {
    active.name = next.name;
  }
  if (next === undefined) await clearCatalog(ctx.storage, id);
  await reloadProviders();
  return { status: "ok" };
}

async function startAgent(ctx: Plugin.Context, agent: AgentConfig): Promise<void> {
  if (!agent.enabled) return;
  const path = findExecutable(agent);
  if (path === undefined) return;
  const active: AgentState = {
    runtime: new AgentRuntime(agent, path, () => {
      setTimeout(() => void reloadProviders(), 0).unref();
    }),
    name: agent.name,
    catalog: await loadCatalog(ctx.storage, agent),
    status: "discovering",
    failure: "",
  };
  running.set(agent.id, active);

  void (async () => {
    try {
      const client = await active.runtime.ensureClient();
      const catalog = await client.discoverModels(process.cwd());
      await enqueue(async () => {
        if (running.get(agent.id) !== active) return;
        if (catalog.models.length === 0) {
          active.status = "failed";
          active.failure = "noModels";
          return;
        }
        active.catalog = catalog;
        await reloadProviders();
        active.status = "ready";
        await saveCatalog(ctx.storage, agent, catalog);
        logInfo("acp", `${agent.id} offers ${catalog.models.length} models`);
      });
    } catch (error) {
      if (running.get(agent.id) !== active) return;
      active.status = "failed";
      const cause = error instanceof AcpStartError ? error.cause : error;
      active.failure =
        cause instanceof RequestError && cause.code === -32000
          ? "login"
          : error instanceof AcpStartError && error.exit !== undefined
            ? "exited"
            : cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
              ? "timeout"
              : error instanceof AcpStartError && error.stage === "spawn"
                ? "spawn"
                : "discovery";
      logWarn("acp", `Model discovery failed for ${agent.id}: ${message(error)}`);
    }
  })();
}

function stopAgent(id: string): void {
  const active = running.get(id);
  running.delete(id);
  active?.runtime.close();
}

function closeAgents(): void {
  for (const id of running.keys()) stopAgent(id);
}

async function reloadProviders(targets: Iterable<Plugin.Context> = locations.keys()): Promise<void> {
  await Promise.all(
    [...targets].map((ctx) =>
      ctx.provider.reload().catch((error: unknown) => {
        logError("acp", `Could not refresh providers: ${message(error)}`);
      }),
    ),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
