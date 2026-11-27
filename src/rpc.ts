import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { LOG_LEVELS } from "./log.js";

export const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Optimistic-concurrency counter shared by the settings views and mutations. */
const RevisionSchema = z.number().int().min(0);

const AgentInputSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Null keeps the value already stored on the server. */
  env: z.record(z.string(), z.string().nullable()),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const PRESETS = [
  { id: "acp-agy", name: "Antigravity", command: "agy", args: ["acp"], env: {} },
] as const satisfies readonly AgentInput[];

const AgentStatusSchema = z.enum(["disabled", "missing", "discovering", "ready", "failed"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

const AgentViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  envKeys: z.array(z.string()),
  enabled: z.boolean(),
  status: AgentStatusSchema,
  modelCount: z.number().int(),
  failure: z.string(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

const SettingsViewSchema = z.strictObject({
  revision: RevisionSchema,
  logLevel: z.enum(LOG_LEVELS),
  agents: z.array(AgentViewSchema),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

const ImportAgentStatusSchema = z.enum(["ready", "stopped", "unsupported", "unavailable", "disabled"]);
export type ImportAgentStatus = z.infer<typeof ImportAgentStatusSchema>;

const ImportableAgentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: ImportAgentStatusSchema,
  reason: z.string(),
});
export type ImportableAgent = z.infer<typeof ImportableAgentSchema>;

const ImportableSessionSchema = z.strictObject({
  agentID: z.string(),
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  updatedAt: z.string(),
  available: z.boolean(),
});
export type ImportableSession = z.infer<typeof ImportableSessionSchema>;

const ImportAgentsViewSchema = z.strictObject({ agents: z.array(ImportableAgentSchema) });
export type ImportAgentsView = z.infer<typeof ImportAgentsViewSchema>;

const ImportSessionsViewSchema = z.strictObject({ sessions: z.array(ImportableSessionSchema) });
export type ImportSessionsView = z.infer<typeof ImportSessionsViewSchema>;

const ImportableSessionsInputSchema = z.strictObject({
  agentID: z.string(),
  /** Lists only this directory and its descendants when given. */
  cwd: z.string().optional(),
});
export type ImportableSessionsInput = z.infer<typeof ImportableSessionsInputSchema>;

const ImportStatusSchema = z.enum([
  "ok",
  "notFound",
  "unsupported",
  "unavailable",
  "alreadyBound",
  "loadFailed",
  "saveFailed",
]);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

const ImportPayloadViewSchema = z.strictObject({
  info: z.record(z.string(), z.unknown()),
  messages: z.array(z.record(z.string(), z.unknown())),
  location: z.strictObject({ directory: z.string() }),
});
export type ImportPayloadView = z.infer<typeof ImportPayloadViewSchema>;

const PrepareImportResultSchema = z.strictObject({
  status: ImportStatusSchema,
  sessionID: z.string(),
  reason: z.string(),
  payload: ImportPayloadViewSchema.optional(),
});
export type PrepareImportResult = z.infer<typeof PrepareImportResultSchema>;

const AbortImportInputSchema = z.strictObject({
  agentID: z.string(),
  sessionID: z.string(),
  opencodeSessionID: z.string(),
});
export type AbortImportInput = z.infer<typeof AbortImportInputSchema>;

const SessionOptionStatusSchema = z.enum(["ok", "notAcp", "unbound", "unavailable", "invalid"]);
export type SessionOptionStatus = z.infer<typeof SessionOptionStatusSchema>;

const SessionOptionValueViewSchema = z.strictObject({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type SessionOptionValueView = z.infer<typeof SessionOptionValueViewSchema>;

const SessionOptionViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["select", "boolean"]),
  current: z.union([z.string(), z.boolean()]),
  values: z.array(SessionOptionValueViewSchema).optional(),
});
export type SessionOptionView = z.infer<typeof SessionOptionViewSchema>;

const SessionCommandViewSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** Placeholder for the command's arguments, when the agent asks for them. */
  hint: z.string().optional(),
});
export type SessionCommandView = z.infer<typeof SessionCommandViewSchema>;

const SessionOptionsViewSchema = z.strictObject({
  status: SessionOptionStatusSchema,
  options: z.array(SessionOptionViewSchema),
  /** Absent when the server predates command listing. */
  commands: z.array(SessionCommandViewSchema).optional(),
});
export type SessionOptionsView = z.infer<typeof SessionOptionsViewSchema>;

const DeleteSessionInputSchema = z.strictObject({
  agentID: z.string(),
  sessionID: z.string(),
});
export type DeleteSessionInput = z.infer<typeof DeleteSessionInputSchema>;

const SessionOptionsInputSchema = z.strictObject({ sessionID: z.string() });
export type SessionOptionsInput = z.infer<typeof SessionOptionsInputSchema>;

const SetSessionOptionInputSchema = z.strictObject({
  sessionID: z.string(),
  configID: z.string(),
  value: z.union([z.string(), z.boolean()]),
});
export type SetSessionOptionInput = z.infer<typeof SetSessionOptionInputSchema>;

const AnswerElicitationInputSchema = z.strictObject({
  requestID: z.string(),
  action: z.enum(["accept", "cancel", "decline"]),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type AnswerElicitationInput = z.infer<typeof AnswerElicitationInputSchema>;

const ElicitationFormInputSchema = z.strictObject({
  requestID: z.string(),
  formID: z.string(),
});
export type ElicitationFormInput = z.infer<typeof ElicitationFormInputSchema>;

const MutationResultSchema = z.strictObject({
  status: z.enum(["ok", "conflict", "busy", "invalid", "duplicate", "notFound", "unsupported", "saveFailed"]),
  field: z.string().optional(),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

const ElicitationFieldOptionSchema = z.strictObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const ElicitationFieldSchema = z.strictObject({
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  type: z.enum(["string", "number", "integer", "boolean", "multiselect"]),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  options: z.array(ElicitationFieldOptionSchema).optional(),
});
export type ElicitationField = z.infer<typeof ElicitationFieldSchema>;

const ElicitationRequestSchema = z.strictObject({
  requestID: z.string(),
  sessionID: z.string(),
  directory: z.string(),
  agentName: z.string(),
  title: z.string(),
  message: z.string().optional(),
  fields: z.array(ElicitationFieldSchema),
  toolCallID: z.string().optional(),
});
export type ElicitationRequestView = z.infer<typeof ElicitationRequestSchema>;

const ElicitationRequestIDSchema = z.strictObject({ requestID: z.string() });

const TargetSchema = z.strictObject({
  revision: RevisionSchema,
  id: z.string(),
});

const EmptyInputSchema = z.strictObject({});

export const AcpSettings = Rpc.define({
  id: "acp",
  events: {
    elicitation: { schema: ElicitationRequestSchema },
    elicitationCancelled: { schema: ElicitationRequestIDSchema },
  },
  methods: {
    settings: { input: EmptyInputSchema, output: SettingsViewSchema },
    saveAgent: {
      input: z.strictObject({
        revision: RevisionSchema,
        create: z.boolean(),
        agent: AgentInputSchema,
      }),
      output: MutationResultSchema,
    },
    setEnabled: {
      input: z.strictObject({
        revision: RevisionSchema,
        id: z.string(),
        enabled: z.boolean(),
      }),
      output: MutationResultSchema,
    },
    removeAgent: { input: TargetSchema, output: MutationResultSchema },
    retryAgent: { input: TargetSchema, output: MutationResultSchema },
    setLogLevel: {
      input: z.strictObject({
        revision: RevisionSchema,
        logLevel: z.enum(LOG_LEVELS),
      }),
      output: MutationResultSchema,
    },
    importAgents: { input: EmptyInputSchema, output: ImportAgentsViewSchema },
    importableSessions: {
      input: ImportableSessionsInputSchema,
      output: ImportSessionsViewSchema,
    },
    prepareImport: {
      input: z.strictObject({ agentID: z.string(), sessionID: z.string() }),
      output: PrepareImportResultSchema,
    },
    abortImport: {
      input: AbortImportInputSchema,
      output: MutationResultSchema,
    },
    deleteSession: {
      input: DeleteSessionInputSchema,
      output: MutationResultSchema,
    },
    sessionOptions: {
      input: SessionOptionsInputSchema,
      output: SessionOptionsViewSchema,
    },
    setSessionOption: {
      input: SetSessionOptionInputSchema,
      output: MutationResultSchema,
    },
    claimElicitation: {
      input: ElicitationRequestIDSchema,
      output: z.strictObject({ claimed: z.boolean() }),
    },
    answerElicitation: {
      input: AnswerElicitationInputSchema,
      output: MutationResultSchema,
    },
    elicitationForm: {
      input: ElicitationFormInputSchema,
      output: MutationResultSchema,
    },
    pendingElicitations: {
      input: EmptyInputSchema,
      output: z.strictObject({ requests: z.array(ElicitationRequestSchema) }),
    },
  },
});
