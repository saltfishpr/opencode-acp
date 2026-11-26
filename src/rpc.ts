import { Rpc } from "@opencode/plugin/rpc";
import { LOG_LEVELS, type LogLevel } from "./log.js";

export const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface AgentInput {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Null keeps the value already stored on the server. */
  readonly env: Readonly<Record<string, string | null>>;
}

export const PRESETS = [
  { id: "acp-agy", name: "Antigravity", command: "agy", args: ["acp"], env: {} },
] as const satisfies readonly AgentInput[];

const STATUS = ["disabled", "missing", "discovering", "ready", "failed"] as const;
export type AgentStatus = (typeof STATUS)[number];

export interface AgentView {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envKeys: readonly string[];
  readonly enabled: boolean;
  readonly status: AgentStatus;
  readonly modelCount: number;
  readonly failure: string;
}

export interface SettingsView {
  readonly revision: number;
  readonly logLevel: LogLevel;
  readonly agents: readonly AgentView[];
}

const RESULTS = ["ok", "conflict", "busy", "invalid", "duplicate", "notFound", "saveFailed"] as const;
export type MutationResult = { readonly status: (typeof RESULTS)[number]; readonly field?: string };

const text = { type: "string" } as const;
const strings = { type: "array", items: text } as const;
const revision = { type: "integer", minimum: 0 } as const;
const logLevel = { enum: LOG_LEVELS } as const;
const result = {
  type: "object",
  properties: { status: { enum: RESULTS }, field: text },
  required: ["status"],
  additionalProperties: false,
} as const;
const target = {
  type: "object",
  properties: { revision, id: text },
  required: ["revision", "id"],
  additionalProperties: false,
} as const;

export const AcpSettings = Rpc.define({
  id: "acp",
  events: {},
  methods: {
    settings: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          revision,
          logLevel,
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: text,
                name: text,
                command: text,
                args: strings,
                envKeys: strings,
                enabled: { type: "boolean" },
                status: { enum: STATUS },
                modelCount: { type: "integer" },
                failure: text,
              },
              required: ["id", "name", "command", "args", "envKeys", "enabled", "status", "modelCount", "failure"],
              additionalProperties: false,
            },
          },
        },
        required: ["revision", "logLevel", "agents"],
        additionalProperties: false,
      },
    },
    saveAgent: {
      input: {
        type: "object",
        properties: {
          revision,
          create: { type: "boolean" },
          agent: {
            type: "object",
            properties: {
              id: text,
              name: text,
              command: text,
              args: strings,
              env: { type: "object", additionalProperties: { type: ["string", "null"] } },
            },
            required: ["id", "name", "command", "args", "env"],
            additionalProperties: false,
          },
        },
        required: ["revision", "create", "agent"],
        additionalProperties: false,
      },
      output: result,
    },
    setEnabled: {
      input: {
        ...target,
        properties: { ...target.properties, enabled: { type: "boolean" } },
        required: [...target.required, "enabled"],
      },
      output: result,
    },
    removeAgent: { input: target, output: result },
    retryAgent: { input: target, output: result },
    setLogLevel: {
      input: {
        type: "object",
        properties: { revision, logLevel },
        required: ["revision", "logLevel"],
        additionalProperties: false,
      },
      output: result,
    },
  },
});
