import { Plugin } from "@opencode/plugin";
import { AgentHub, clearCatalog } from "./agent-hub.js";
import {
  EMPTY_CONFIG,
  PLUGIN_ID,
  isLogLevel,
  readConfig,
  sameLaunch,
  type AgentConfig,
  type Config,
} from "./config.js";
import { Coordinator, SessionTitles } from "./coordinator.js";
import { ElicitationBroker } from "./interaction/elicitation.js";
import { PermissionBroker } from "./interaction/permission.js";
import { logError, logWarn, setLogLevel } from "./log.js";
import { PACKAGE, registerProviders } from "./provider.js";
import { AcpRpc, AGENT_ID, type MutationResult } from "./rpc.js";

const SETTINGS_KEY = "acp/settings";
const stateKey = Symbol.for("opencode-acp/server-state/v2");

interface ServerState {
  readonly locations: Map<Plugin.Context, ReadonlySet<string>>;
  readonly hub: AgentHub;
  /** Shared across locations so an imported title follows the session. */
  readonly titles: SessionTitles;
  readonly onExit: () => void;
  config: Config;
  queue: Promise<void>;
}

// OpenCode can evaluate a separate copy of the plugin module for each location.
const scope = globalThis as typeof globalThis & { [stateKey]?: ServerState };
const state: ServerState = (scope[stateKey] ??= createState());

function createState(): ServerState {
  const hub = new AgentHub({ onProviderChange: () => void reloadProviders() });
  return {
    locations: new Map(),
    hub,
    titles: new SessionTitles(),
    onExit: () => hub.stopAll(),
    config: EMPTY_CONFIG,
    queue: Promise.resolve(),
  };
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const permissions = new PermissionBroker(ctx);
    const elicitations = new ElicitationBroker();
    const coordinator = new Coordinator(state.hub, state.titles);

    const { registrations, occupied } = await registerProviders(ctx, {
      hub: state.hub,
      titles: state.titles,
      requestPermission: (params, turn) => permissions.request(params, turn),
      requestElicitation: (params, turn) => elicitations.request(params, turn),
    });

    try {
      await enqueue(async () => {
        if (state.locations.size === 0) {
          state.config = readConfig(await ctx.storage.get(SETTINGS_KEY));
          setLogLevel(state.config.logLevel);
          process.on("exit", state.onExit);
          for (const agent of state.config.agents) await state.hub.startAgent(ctx, agent);
        }
        state.locations.set(ctx, occupied);
        await reloadProviders([ctx]);
      });
    } catch (error) {
      permissions.close();
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      throw error;
    }

    const rpc = await ctx.rpc.register(AcpRpc, {
      async settings() {
        return enqueue(async () => state.hub.settingsView(state.config));
      },
      saveAgent({ revision, create, agent }) {
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
            for (const [location, occupied] of state.locations) {
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
      setEnabled({ revision, id, enabled }) {
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (agent.enabled === enabled) return { status: "ok" };
          return saveAgent(ctx, id, agent, { ...agent, enabled });
        });
      },
      removeAgent({ revision, id }) {
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          return saveAgent(ctx, id, agent, undefined);
        });
      },
      retryAgent({ revision, id }) {
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (!agent.enabled) return { status: "conflict" };
          const active = state.hub.get(id);
          if (active?.status === "discovering") return { status: "ok" };
          if (active !== undefined && !state.hub.pause(id)) return { status: "busy" };
          state.hub.stopAgent(id);
          await state.hub.startAgent(ctx, agent);
          await reloadProviders();
          return { status: "ok" };
        });
      },
      setLogLevel({ revision, logLevel }) {
        return mutate(revision, async () => {
          if (!isLogLevel(logLevel)) return { status: "invalid" };
          if (logLevel !== state.config.logLevel) {
            await persist(ctx, { ...state.config, logLevel });
            setLogLevel(logLevel);
          }
          return { status: "ok" };
        });
      },
      listAgents() {
        return Promise.resolve(coordinator.listAgents(state.config));
      },
      listSessions(input) {
        return coordinator.listSessions(state.config, input);
      },
      sessionMeta(input) {
        return coordinator.sessionMeta(ctx, state.config, input);
      },
      rebuildSession(input) {
        return coordinator.rebuildSession(ctx, state.config, input);
      },
      deleteSession(input) {
        return coordinator.deleteSession(state.config, input);
      },
      sessionState(input) {
        return coordinator.sessionState(ctx, state.config, input);
      },
      setSessionOption(input) {
        return coordinator.setSessionOption(ctx, state.config, input);
      },
      runCommand(input) {
        return coordinator.runCommand(ctx, state.config, input);
      },
      claimElicitation({ requestID }) {
        return Promise.resolve({ claimed: elicitations.claim(requestID) });
      },
      answerElicitation({ requestID, action, content }) {
        const answered = elicitations.answer(requestID, action, content);
        return Promise.resolve<MutationResult>({ status: answered ? "ok" : "notFound" });
      },
      elicitationForm({ requestID, formID }) {
        return Promise.resolve<MutationResult>({
          status: elicitations.form(requestID, formID) ? "ok" : "notFound",
        });
      },
      pendingElicitations() {
        return Promise.resolve({ requests: elicitations.pendingRequests() });
      },
    });

    elicitations.attach({
      request(view) {
        void rpc.events
          .emit("elicitation", view)
          .catch((error: unknown) => logWarn("acp", `could not publish an elicitation: ${message(error)}`));
      },
      cancelled(requestID) {
        return rpc.events
          .emit("elicitationCancelled", { requestID })
          .catch((error: unknown) => logWarn("acp", `could not cancel an elicitation: ${message(error)}`));
      },
    });

    return async () => {
      // Let GUI windows cancel their forms before the RPC channel goes away.
      await elicitations.close();
      await rpc.dispose();
      await enqueue(async () => {
        state.locations.delete(ctx);
        if (state.locations.size === 0) {
          process.off("exit", state.onExit);
          state.hub.stopAll();
          state.titles.clear();
        }
      });
      permissions.close();
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});

async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
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
  const active = state.hub.get(id);
  const launchChanged = previous !== undefined && next !== undefined && !sameLaunch(previous, next);
  const restart = launchChanged || previous?.enabled !== next?.enabled;
  if (restart && active !== undefined && !state.hub.pause(id)) return { status: "busy" };

  try {
    const agents = state.config.agents.flatMap((agent) =>
      agent.id === id ? (next === undefined ? [] : [next]) : [agent],
    );
    if (previous === undefined && next !== undefined) agents.push(next);
    await persist(ctx, { ...state.config, agents });
  } catch (error) {
    if (active !== undefined) state.hub.resume(id);
    throw error;
  }

  if (restart) {
    state.hub.stopAgent(id);
    if (next !== undefined) await state.hub.startAgent(ctx, next);
  } else if (active !== undefined && next !== undefined) {
    active.agent = next;
  }
  if (next === undefined) await clearCatalog(ctx.storage, id);
  await reloadProviders();
  return { status: "ok" };
}

async function reloadProviders(targets: Iterable<Plugin.Context> = state.locations.keys()): Promise<void> {
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
