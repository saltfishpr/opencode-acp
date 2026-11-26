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

const IMPORT_AGENT_STATUS = ["ready", "stopped", "unsupported", "unavailable", "disabled"] as const;
export type ImportAgentStatus = (typeof IMPORT_AGENT_STATUS)[number];

export interface ImportableAgent {
  readonly id: string;
  readonly name: string;
  readonly status: ImportAgentStatus;
  readonly reason: string;
}

export interface ImportableSession {
  readonly agentID: string;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: string;
  readonly available: boolean;
}

export interface ImportAgentsView {
  readonly agents: readonly ImportableAgent[];
}

export interface ImportSessionsView {
  readonly sessions: readonly ImportableSession[];
}

export interface ImportableSessionsInput {
  readonly agentID: string;
  /** Lists only this directory and its descendants when given. */
  readonly cwd?: string;
}

const IMPORT_STATUS = [
  "ok",
  "notFound",
  "unsupported",
  "unavailable",
  "alreadyBound",
  "loadFailed",
  "saveFailed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUS)[number];

export interface ImportPayloadView {
  readonly info: Record<string, unknown>;
  readonly messages: readonly Record<string, unknown>[];
  readonly location: { readonly directory: string };
}

export interface PrepareImportResult {
  readonly status: ImportStatus;
  readonly sessionID: string;
  readonly reason: string;
  readonly payload?: ImportPayloadView;
}

export interface AbortImportInput {
  readonly agentID: string;
  readonly sessionID: string;
  readonly opencodeSessionID: string;
}

const SESSION_OPTION_STATUS = ["ok", "notAcp", "unbound", "unavailable", "invalid"] as const;
export type SessionOptionStatus = (typeof SESSION_OPTION_STATUS)[number];

export interface SessionOptionValueView {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface SessionOptionView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type: "select" | "boolean";
  readonly current: string | boolean;
  readonly values?: readonly SessionOptionValueView[];
}

export interface SessionOptionsView {
  readonly status: SessionOptionStatus;
  readonly options: readonly SessionOptionView[];
}

export interface SessionOptionsInput {
  readonly sessionID: string;
}

export interface SetSessionOptionInput {
  readonly sessionID: string;
  readonly configID: string;
  readonly value: string | boolean;
}

export interface ClaimElicitationInput {
  readonly requestID: string;
}

export interface AnswerElicitationInput {
  readonly requestID: string;
  readonly action: "accept" | "cancel" | "decline";
  readonly content?: Record<string, unknown>;
}

export interface ElicitationFormInput {
  readonly requestID: string;
  readonly formID: string;
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

const importableAgent = {
  type: "object",
  properties: {
    id: text,
    name: text,
    status: { enum: IMPORT_AGENT_STATUS },
    reason: text,
  },
  required: ["id", "name", "status", "reason"],
  additionalProperties: false,
} as const;

const importableSession = {
  type: "object",
  properties: {
    agentID: text,
    id: text,
    title: text,
    cwd: text,
    updatedAt: text,
    available: { type: "boolean" },
  },
  required: ["agentID", "id", "title", "cwd", "updatedAt", "available"],
  additionalProperties: false,
} as const;

const importPayload = {
  type: "object",
  properties: {
    info: { type: "object", additionalProperties: true },
    messages: { type: "array", items: { type: "object", additionalProperties: true } },
    location: {
      type: "object",
      properties: { directory: text },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  required: ["info", "messages", "location"],
  additionalProperties: false,
} as const;

const prepareImportResult = {
  type: "object",
  properties: {
    status: { enum: IMPORT_STATUS },
    sessionID: text,
    reason: text,
    payload: importPayload,
  },
  required: ["status", "sessionID", "reason"],
  additionalProperties: false,
} as const;

const importTarget = {
  type: "object",
  properties: { agentID: text, sessionID: text },
  required: ["agentID", "sessionID"],
  additionalProperties: false,
} as const;

const abortImportInput = {
  type: "object",
  properties: { agentID: text, sessionID: text, opencodeSessionID: text },
  required: ["agentID", "sessionID", "opencodeSessionID"],
  additionalProperties: false,
} as const;

const sessionOptionValue = {
  type: "object",
  properties: { value: text, name: text, description: text },
  required: ["value", "name"],
  additionalProperties: false,
} as const;

const sessionOption = {
  type: "object",
  properties: {
    id: text,
    name: text,
    description: text,
    category: text,
    type: { enum: ["select", "boolean"] },
    current: { type: ["string", "boolean"] },
    values: { type: "array", items: sessionOptionValue },
  },
  required: ["id", "name", "type", "current"],
  additionalProperties: false,
} as const;

const sessionOptionsOutput = {
  type: "object",
  properties: {
    status: { enum: SESSION_OPTION_STATUS },
    options: { type: "array", items: sessionOption },
  },
  required: ["status", "options"],
  additionalProperties: false,
} as const;

const setSessionOptionInput = {
  type: "object",
  properties: { sessionID: text, configID: text, value: { type: ["string", "boolean"] } },
  required: ["sessionID", "configID", "value"],
  additionalProperties: false,
} as const;

const elicitationRequest = {
  type: "object",
  properties: {
    requestID: text,
    sessionID: text,
    directory: text,
    agentName: text,
    title: text,
    message: text,
    fields: { type: "array", items: { type: "object", additionalProperties: true } },
    toolCallID: text,
  },
  required: ["requestID", "sessionID", "directory", "agentName", "title", "fields"],
  additionalProperties: false,
} as const;

const elicitationRequestID = {
  type: "object",
  properties: { requestID: text },
  required: ["requestID"],
  additionalProperties: false,
} as const;

const answerElicitationInput = {
  type: "object",
  properties: {
    requestID: text,
    action: { enum: ["accept", "cancel", "decline"] },
    content: { type: "object", additionalProperties: true },
  },
  required: ["requestID", "action"],
  additionalProperties: false,
} as const;

const elicitationFormInput = {
  type: "object",
  properties: { requestID: text, formID: text },
  required: ["requestID", "formID"],
  additionalProperties: false,
} as const;

export const AcpSettings = Rpc.define({
  id: "acp",
  events: {
    elicitation: { schema: elicitationRequest },
    elicitationCancelled: { schema: elicitationRequestID },
  },
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
    importAgents: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          agents: { type: "array", items: importableAgent },
        },
        required: ["agents"],
        additionalProperties: false,
      },
    },
    importableSessions: {
      input: {
        type: "object",
        properties: { agentID: text, cwd: text },
        required: ["agentID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessions: { type: "array", items: importableSession },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
    prepareImport: {
      input: importTarget,
      output: prepareImportResult,
    },
    abortImport: {
      input: abortImportInput,
      output: result,
    },
    sessionOptions: {
      input: {
        type: "object",
        properties: { sessionID: text },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: sessionOptionsOutput,
    },
    setSessionOption: {
      input: setSessionOptionInput,
      output: result,
    },
    claimElicitation: {
      input: elicitationRequestID,
      output: {
        type: "object",
        properties: { claimed: { type: "boolean" } },
        required: ["claimed"],
        additionalProperties: false,
      },
    },
    answerElicitation: {
      input: answerElicitationInput,
      output: result,
    },
    elicitationForm: {
      input: elicitationFormInput,
      output: result,
    },
    pendingElicitations: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { requests: { type: "array", items: elicitationRequest } },
        required: ["requests"],
        additionalProperties: false,
      },
    },
  },
});
