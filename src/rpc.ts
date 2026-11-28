import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { LOG_LEVELS } from "./log.js";

export const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Optimistic-concurrency counter shared by the settings views and mutations. */
const RevisionSchema = z.number().int().min(0);

const MutationResultSchema = z.strictObject({
  status: z.enum(["ok", "conflict", "busy", "invalid", "duplicate", "notFound", "unsupported", "saveFailed"]),
  field: z.string().optional(),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

const EmptyInputSchema = z.strictObject({});
export type EmptyInput = z.infer<typeof EmptyInputSchema>;

const AgentStatusSchema = z.enum(["disabled", "missing", "discovering", "ready", "failed"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

const AgentModeViewSchema = z.strictObject({
  value: z.string(),
  name: z.string(),
});
export type AgentModeView = z.infer<typeof AgentModeViewSchema>;

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
  modes: z.array(AgentModeViewSchema),
  defaultMode: z.string(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

const SettingsViewSchema = z.strictObject({
  revision: RevisionSchema,
  logLevel: z.enum(LOG_LEVELS),
  agents: z.array(AgentViewSchema),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

const AgentInputSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Null keeps the value already stored on the server. */
  env: z.record(z.string(), z.string().nullable()),
  /** Omitted keeps the value already stored on the server. */
  defaultMode: z.string().optional(),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const PRESETS = [
  { id: "acp-agy", name: "Antigravity", command: "agy", args: ["acp"], env: {} },
] as const satisfies readonly AgentInput[];

const SaveAgentInputSchema = z.strictObject({
  revision: RevisionSchema,
  create: z.boolean(),
  agent: AgentInputSchema,
});
export type SaveAgentInput = z.infer<typeof SaveAgentInputSchema>;

const SetEnabledInputSchema = z.strictObject({
  revision: RevisionSchema,
  id: z.string(),
  enabled: z.boolean(),
});
export type SetEnabledInput = z.infer<typeof SetEnabledInputSchema>;

const AgentTargetInputSchema = z.strictObject({
  revision: RevisionSchema,
  id: z.string(),
});
export type AgentTargetInput = z.infer<typeof AgentTargetInputSchema>;

const SetLogLevelInputSchema = z.strictObject({
  revision: RevisionSchema,
  logLevel: z.enum(LOG_LEVELS),
});
export type SetLogLevelInput = z.infer<typeof SetLogLevelInputSchema>;

const SetDefaultModeInputSchema = z.strictObject({
  revision: RevisionSchema,
  id: z.string(),
  defaultMode: z.string(),
});
export type SetDefaultModeInput = z.infer<typeof SetDefaultModeInputSchema>;

const SessionAgentStatusSchema = z.enum(["ready", "stopped", "unsupported", "unavailable", "disabled"]);
export type SessionAgentStatus = z.infer<typeof SessionAgentStatusSchema>;

const SessionAgentViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: SessionAgentStatusSchema,
  reason: z.string(),
  canDelete: z.boolean(),
});
export type SessionAgentView = z.infer<typeof SessionAgentViewSchema>;

const SessionAgentsViewSchema = z.strictObject({ agents: z.array(SessionAgentViewSchema) });
export type SessionAgentsView = z.infer<typeof SessionAgentsViewSchema>;

const ListSessionsInputSchema = z.strictObject({
  agentID: z.string(),
  /** Lists only this directory and its descendants when given. */
  cwd: z.string().optional(),
});
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;

const AgentSessionViewSchema = z.strictObject({
  agentID: z.string(),
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  updatedAt: z.string(),
  available: z.boolean(),
});
export type AgentSessionView = z.infer<typeof AgentSessionViewSchema>;

const AgentSessionsViewSchema = z.strictObject({ sessions: z.array(AgentSessionViewSchema) });
export type AgentSessionsView = z.infer<typeof AgentSessionsViewSchema>;

const SessionMetaInputSchema = z.strictObject({ sessionID: z.string() });
export type SessionMetaInput = z.infer<typeof SessionMetaInputSchema>;

const SessionMetaStatusSchema = z.enum(["ok", "notAcp", "unbound", "unavailable"]);
export type SessionMetaStatus = z.infer<typeof SessionMetaStatusSchema>;

const SessionMetaViewSchema = z.strictObject({
  status: SessionMetaStatusSchema,
  agentID: z.string().optional(),
  acpSessionID: z.string().optional(),
  cwd: z.string().optional(),
  localUpdatedAt: z.string().optional(),
  remoteUpdatedAt: z.string().optional(),
});
export type SessionMetaView = z.infer<typeof SessionMetaViewSchema>;

const RebuildSessionInputSchema = z.strictObject({
  agentID: z.string(),
  acpSessionID: z.string(),
  cwd: z.string().optional(),
});
export type RebuildSessionInput = z.infer<typeof RebuildSessionInputSchema>;

const RebuildSessionStatusSchema = z.enum(["ok", "notFound", "unsupported", "unavailable", "loadFailed"]);
export type RebuildSessionStatus = z.infer<typeof RebuildSessionStatusSchema>;

const RebuiltPayloadViewSchema = z.strictObject({
  info: z.record(z.string(), z.unknown()),
  messages: z.array(z.record(z.string(), z.unknown())),
  location: z.strictObject({ directory: z.string() }),
});
export type RebuiltPayloadView = z.infer<typeof RebuiltPayloadViewSchema>;

const RebuildSessionResultSchema = z.strictObject({
  status: RebuildSessionStatusSchema,
  sessionID: z.string(),
  reason: z.string(),
  updatedAt: z.string(),
  payload: RebuiltPayloadViewSchema.optional(),
});
export type RebuildSessionResult = z.infer<typeof RebuildSessionResultSchema>;

const DeleteSessionInputSchema = z.strictObject({
  agentID: z.string(),
  sessionID: z.string(),
});
export type DeleteSessionInput = z.infer<typeof DeleteSessionInputSchema>;

const SessionStateInputSchema = z.strictObject({
  sessionID: z.string(),
  ensureLoaded: z.boolean().optional(),
});
export type SessionStateInput = z.infer<typeof SessionStateInputSchema>;

const SessionStateStatusSchema = z.enum(["ok", "cached", "notAcp", "unbound", "unavailable"]);
export type SessionStateStatus = z.infer<typeof SessionStateStatusSchema>;

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

const SessionStateViewSchema = z.strictObject({
  status: SessionStateStatusSchema,
  agentID: z.string().optional(),
  agentName: z.string().optional(),
  acpSessionID: z.string().optional(),
  cwd: z.string().optional(),
  options: z.array(SessionOptionViewSchema),
  commands: z.array(SessionCommandViewSchema),
});
export type SessionStateView = z.infer<typeof SessionStateViewSchema>;

const SetSessionOptionInputSchema = z.strictObject({
  sessionID: z.string(),
  configID: z.string(),
  value: z.union([z.string(), z.boolean()]),
});
export type SetSessionOptionInput = z.infer<typeof SetSessionOptionInputSchema>;

const RunCommandInputSchema = z.strictObject({
  sessionID: z.string(),
  name: z.string(),
  input: z.string(),
  delivery: z.enum(["steer", "queue"]).optional(),
});
export type RunCommandInput = z.infer<typeof RunCommandInputSchema>;

const RunCommandStatusSchema = z.enum(["ok", "notAcp", "notFound", "unavailable", "failed"]);
export type RunCommandStatus = z.infer<typeof RunCommandStatusSchema>;

const RunCommandResultSchema = z.strictObject({
  status: RunCommandStatusSchema,
  message: z.string().optional(),
});
export type RunCommandResult = z.infer<typeof RunCommandResultSchema>;

const ElicitationFieldOptionSchema = z.strictObject({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type ElicitationFieldOption = z.infer<typeof ElicitationFieldOptionSchema>;

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

const ElicitationRequestViewSchema = z.strictObject({
  requestID: z.string(),
  sessionID: z.string(),
  directory: z.string(),
  agentName: z.string(),
  title: z.string(),
  message: z.string().optional(),
  fields: z.array(ElicitationFieldSchema),
  toolCallID: z.string().optional(),
});
export type ElicitationRequestView = z.infer<typeof ElicitationRequestViewSchema>;

const ElicitationRequestIDSchema = z.strictObject({ requestID: z.string() });
export type ElicitationRequestID = z.infer<typeof ElicitationRequestIDSchema>;

const ClaimElicitationResultSchema = z.strictObject({ claimed: z.boolean() });
export type ClaimElicitationResult = z.infer<typeof ClaimElicitationResultSchema>;

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

const PendingElicitationsViewSchema = z.strictObject({
  requests: z.array(ElicitationRequestViewSchema),
});
export type PendingElicitationsView = z.infer<typeof PendingElicitationsViewSchema>;

export const AcpRpc = Rpc.define({
  id: "acp",
  events: {
    elicitation: { schema: ElicitationRequestViewSchema },
    elicitationCancelled: { schema: ElicitationRequestIDSchema },
  },
  methods: {
    settings: { input: EmptyInputSchema, output: SettingsViewSchema },
    saveAgent: { input: SaveAgentInputSchema, output: MutationResultSchema },
    setEnabled: { input: SetEnabledInputSchema, output: MutationResultSchema },
    removeAgent: { input: AgentTargetInputSchema, output: MutationResultSchema },
    retryAgent: { input: AgentTargetInputSchema, output: MutationResultSchema },
    setDefaultMode: { input: SetDefaultModeInputSchema, output: MutationResultSchema },
    setLogLevel: { input: SetLogLevelInputSchema, output: MutationResultSchema },
    listAgents: { input: EmptyInputSchema, output: SessionAgentsViewSchema },
    listSessions: { input: ListSessionsInputSchema, output: AgentSessionsViewSchema },
    sessionMeta: { input: SessionMetaInputSchema, output: SessionMetaViewSchema },
    rebuildSession: { input: RebuildSessionInputSchema, output: RebuildSessionResultSchema },
    deleteSession: { input: DeleteSessionInputSchema, output: MutationResultSchema },
    sessionState: { input: SessionStateInputSchema, output: SessionStateViewSchema },
    setSessionOption: { input: SetSessionOptionInputSchema, output: MutationResultSchema },
    runCommand: { input: RunCommandInputSchema, output: RunCommandResultSchema },
    claimElicitation: { input: ElicitationRequestIDSchema, output: ClaimElicitationResultSchema },
    answerElicitation: { input: AnswerElicitationInputSchema, output: MutationResultSchema },
    elicitationForm: { input: ElicitationFormInputSchema, output: MutationResultSchema },
    pendingElicitations: { input: EmptyInputSchema, output: PendingElicitationsViewSchema },
  },
});
