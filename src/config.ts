import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./log.js";
import { AGENT_ID } from "./rpc.js";

export const PLUGIN_ID = "opencode-acp";

const LogLevelSchema = z.enum(LOG_LEVELS);

const AgentConfigSchema = z
  .object({
    id: z.string().regex(AGENT_ID),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).readonly(),
    env: z.record(z.string(), z.string()).readonly(),
    enabled: z.boolean(),
    /** Mode a new ACP session starts in; empty keeps the agent's own default. */
    defaultMode: z.string().default(""),
  })
  .readonly();

const ConfigSchema = z
  .object({
    revision: z.int().nonnegative(),
    logLevel: LogLevelSchema,
    agents: z.array(AgentConfigSchema).readonly(),
  })
  .readonly();

/** The provider ID is persisted in OpenCode's model selections. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const EMPTY_CONFIG: Config = { revision: 0, logLevel: "info", agents: [] };

export function isLogLevel(value: unknown): value is LogLevel {
  return LogLevelSchema.safeParse(value).success;
}

/** A failed read must not look like empty settings that the next save could overwrite. */
export function readConfig(value: unknown): Config {
  return value === undefined ? EMPTY_CONFIG : ConfigSchema.parse(value);
}

export function sameLaunch(agent: AgentConfig, next: AgentConfig): boolean {
  const keys = Object.keys(next.env);
  return (
    agent.command === next.command &&
    agent.args.length === next.args.length &&
    agent.args.every((arg, index) => arg === next.args[index]) &&
    Object.keys(agent.env).length === keys.length &&
    keys.every((key) => agent.env[key] === next.env[key])
  );
}
