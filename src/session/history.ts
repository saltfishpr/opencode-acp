import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { base64Bytes, normalizeBase64 } from "../provider/base64.js";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, saveAgentAudio, saveAgentImage } from "../provider/media.js";
import { extensionFor, mediaKind, mimeFromName, normalizeMediaType, type MediaKind } from "../provider/mime.js";
import { ToolProjector } from "../provider/projection.js";

/** Total decoded media bytes imported into one session. */
const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface HistoryModel {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export interface HistoryInput {
  readonly agentID: string;
  readonly agentName: string;
  readonly acpSessionID: string;
  readonly opencodeSessionID: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly model: HistoryModel;
  readonly updates: readonly SessionUpdate[];
}

export interface ImportPayload {
  readonly info: Record<string, unknown>;
  readonly messages: Record<string, unknown>[];
  readonly location: { readonly directory: string };
  readonly title: string;
}

interface StoredMessage {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  [key: string]: unknown;
}

interface UserFile {
  data: string;
  mime: string;
  source: { type: "inline" };
  name: string;
}

interface UserState {
  id: string;
  text: string;
  files: UserFile[];
  messageID?: string;
}

interface TextPart {
  type: "text";
  text: string;
}

interface ReasoningPart {
  type: "reasoning";
  text: string;
}

interface ToolState {
  status: "running" | "completed" | "error";
  input: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
  error?: { type: string; message: string };
}

interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  executed: true;
  state: ToolState;
  time: { created: number; ran?: number; completed?: number };
}

type AssistantPart = TextPart | ReasoningPart | ToolPart;

interface AssistantState {
  id: string;
  content: AssistantPart[];
  projector: ToolProjector;
  tools: Map<string, number>;
  toolContent: Map<string, ToolCallContent[]>;
  messageID?: string;
}

interface MediaPayload {
  readonly base64: string;
  readonly bytes: number;
  readonly mime: string;
}

/**
 * Turns the updates replayed by `session/load` into the payload accepted by
 * OpenCode's experimental session import.
 *
 * User media stays attached to the user message. Agent and tool media follow
 * the live plugin behavior: they are written under the server's temp directory
 * and referenced by an absolute path in the assistant text.
 */
export async function buildImportPayload(input: HistoryInput): Promise<ImportPayload> {
  let user: UserState | undefined;
  let assistant: AssistantState | undefined;
  let title = input.title.trim();
  let updatedAt = input.updatedAt;
  let usage = 0;
  let firstUserText = "";
  let budget = MAX_TOTAL_ATTACHMENT_BYTES;
  const messages: StoredMessage[] = [];
  const compactions = new Map<string, string>();

  const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`;

  function ensureUser(): UserState {
    user ??= { id: messageID(), text: "", files: [] };
    return user;
  }

  function flushUser(): void {
    if (user === undefined) return;

    const text = user.text.trim();
    if (text.length === 0 && user.files.length === 0) {
      user = undefined;
      return;
    }

    const message: StoredMessage = { id: user.id, type: "user", text, time: { created: 0 } };
    if (user.files.length > 0) message.files = user.files;
    messages.push(message);
    if (firstUserText === "" && text.length > 0) firstUserText = text;
    user = undefined;
  }

  function ensureAssistant(): AssistantState {
    assistant ??= {
      id: messageID(),
      content: [],
      projector: new ToolProjector({ cwd: input.cwd }),
      tools: new Map(),
      toolContent: new Map(),
    };
    return assistant;
  }

  async function flushAssistant(): Promise<void> {
    if (assistant === undefined) return;

    const current = assistant;
    assistant = undefined;
    applyParts(current, current.projector.finish());
    for (const content of current.toolContent.values()) await collectToolMedia(current, content);
    if (current.content.length === 0) return;

    messages.push({
      id: current.id,
      type: "assistant",
      agent: "build",
      model: input.model,
      content: current.content,
      time: { created: 0, completed: 0 },
    });
  }

  function appendText(current: AssistantState, text: string, separate = false): void {
    if (text.length === 0) return;

    const last = current.content.at(-1);
    if (!separate && last?.type === "text") {
      last.text += text;
      return;
    }

    current.content.push({
      type: "text",
      text: separate ? `${current.content.length > 0 ? "\n\n" : ""}${text}\n\n` : text,
    });
  }

  function appendReasoning(current: AssistantState, text: string): void {
    if (text.length === 0) return;

    const last = current.content.at(-1);
    if (last?.type === "reasoning") {
      last.text += text;
      return;
    }
    current.content.push({ type: "reasoning", text });
  }

  function appendUserNote(target: UserState, text: string): void {
    target.text = target.text.length === 0 ? text : `${target.text}\n\n${text}`;
  }

  async function ingestUserContent(target: UserState, content: ContentBlock): Promise<void> {
    if (content.type === "text") {
      target.text += content.text;
      return;
    }

    if (content.type === "image" || content.type === "audio") {
      await addUserMedia(
        target,
        content.data,
        content.mimeType,
        content.type,
        content.type === "image" ? content.uri : undefined,
      );
      return;
    }

    if (content.type === "resource") {
      const resource = content.resource;
      if ("text" in resource) {
        target.text += resource.text;
        return;
      }

      const mime = resource.mimeType ?? mimeFromName(resource.uri);
      const kind = mediaKind(mime);
      if (mime === undefined || kind === undefined) {
        appendUserNote(target, `[附件未导入：${resource.uri}]`);
        return;
      }
      await addUserMedia(target, resource.blob, mime, kind, resource.uri);
      return;
    }

    if (content.type === "resource_link") {
      if (!(await addUserLink(target, content.uri, content.mimeType, content.name))) {
        appendUserNote(target, `[${content.name}](${content.uri})`);
      }
    }
  }

  async function addUserMedia(
    target: UserState,
    data: string,
    mimeHint: string | null | undefined,
    kind: MediaKind,
    uri?: string | null,
  ): Promise<void> {
    const mime = normalizedMime(mimeHint, kind, uri);
    if (mime === undefined) {
      appendUserNote(target, `[附件未导入：${uri ?? mimeHint ?? "未知格式"}]`);
      return;
    }

    const payload = decodeMedia(data, mime);
    if (payload === undefined) {
      appendUserNote(target, `[${label(kind)}未导入：无法读取附件数据]`);
      return;
    }
    if (payload.bytes > capOf(kind)) {
      appendUserNote(target, `[${label(kind)}未导入：超过 ${megabytes(capOf(kind))} MB]`);
      return;
    }
    if (payload.bytes > budget) {
      appendUserNote(target, `[${label(kind)}未导入：超过本次导入的附件上限]`);
      return;
    }

    budget -= payload.bytes;
    target.files.push({
      data: payload.base64,
      mime: payload.mime,
      source: { type: "inline" },
      name: fileName(uri, payload.mime, kind),
    });
  }

  async function addUserLink(
    target: UserState,
    uri: string,
    mimeHint: string | null | undefined,
    name: string,
  ): Promise<boolean> {
    if (uri.startsWith("data:")) {
      const header = dataURLMime(uri);
      const kind = mediaKind(header);
      if (header === undefined || kind === undefined) return false;
      await addUserMedia(target, uri, header, kind);
      return true;
    }

    const path = localPath(uri);
    if (path === undefined) return false;

    const detected = mediaKind(mimeHint) ?? mediaKind(mimeFromName(path));
    if (detected === undefined) return false;
    const mime = normalizedMime(mimeHint, detected, path);
    if (mime === undefined) return false;
    const kind = mediaKind(mime);
    if (kind === undefined) return false;

    try {
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) return false;
      if (info.size > capOf(kind) || info.size > budget) {
        appendUserNote(target, `[${label(kind)}未导入：超过大小上限]`);
        return true;
      }

      const bytes = await readFile(path);
      budget -= bytes.byteLength;
      target.files.push({
        data: bytes.toString("base64"),
        mime,
        source: { type: "inline" },
        name: basename(path) || name || fileName(path, mime, kind),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function ingestAssistantContent(current: AssistantState, content: ContentBlock): Promise<void> {
    if (content.type === "text") {
      appendText(current, content.text);
      return;
    }
    await ingestAssistantMedia(current, content);
  }

  async function ingestAssistantMedia(current: AssistantState, content: ContentBlock): Promise<void> {
    if (content.type === "text") {
      appendText(current, content.text);
      return;
    }

    if (content.type === "image" || content.type === "audio") {
      await saveAssistantMedia(
        current,
        content.data,
        content.mimeType,
        content.type,
        content.type === "image" ? content.uri : undefined,
      );
      return;
    }

    if (content.type === "resource") {
      const resource = content.resource;
      if ("text" in resource) {
        appendText(current, resource.text);
        return;
      }

      const mime = resource.mimeType ?? mimeFromName(resource.uri);
      const kind = mediaKind(mime);
      if (mime === undefined || kind === undefined) {
        appendText(current, `[附件：${resource.uri}]`, true);
        return;
      }
      await saveAssistantMedia(current, resource.blob, mime, kind, resource.uri);
      return;
    }

    if (content.type === "resource_link") {
      const path = localPath(content.uri);
      const mime = content.mimeType ?? (path === undefined ? undefined : mimeFromName(path));
      const kind = mediaKind(mime);
      appendText(
        current,
        kind !== undefined && path !== undefined ? `${label(kind)}：${path}` : `[${content.name}](${content.uri})`,
        true,
      );
    }
  }

  async function collectToolMedia(current: AssistantState, content: ToolCallContent[]): Promise<void> {
    for (const item of content) {
      if (item.type !== "content") continue;

      const block = item.content;
      if (block.type === "text") continue;
      if (block.type === "resource" && "text" in block.resource) continue;
      await ingestAssistantMedia(current, block);
    }
  }

  async function saveAssistantMedia(
    current: AssistantState,
    data: string,
    mimeHint: string | null | undefined,
    kind: MediaKind,
    uri?: string | null,
  ): Promise<void> {
    const mime = normalizedMime(mimeHint, kind, uri);
    if (mime === undefined) {
      appendText(current, `[${label(kind)}未导入：未知格式]`, true);
      return;
    }

    const payload = decodeMedia(data, mime);
    if (payload === undefined) {
      appendText(current, `[${label(kind)}未保存：无法读取附件数据]`, true);
      return;
    }
    if (payload.bytes > capOf(kind)) {
      appendText(current, `[${label(kind)}未保存：超过 ${megabytes(capOf(kind))} MB]`, true);
      return;
    }
    if (payload.bytes > budget) {
      appendText(current, `[${label(kind)}未保存：超过本次导入的附件上限]`, true);
      return;
    }

    budget -= payload.bytes;
    const saved =
      kind === "image"
        ? await saveAgentImage(input.opencodeSessionID, payload.base64, payload.mime)
        : await saveAgentAudio(input.opencodeSessionID, payload.base64, payload.mime);
    appendText(
      current,
      saved === undefined
        ? `收到${label(kind) === "图片" ? "一张图片" : "一段音频"}，但未能保存。`
        : `${label(kind)}已保存：${saved}`,
      true,
    );
  }

  function applyParts(current: AssistantState, parts: LanguageModelV3StreamPart[]): void {
    for (const part of parts) {
      if (part.type === "tool-call") {
        current.content.push({
          type: "tool",
          id: part.toolCallId,
          name: part.toolName,
          executed: true,
          state: { status: "running", input: parseToolInput(part.input) },
          time: { created: 0 },
        });
        current.tools.set(part.toolCallId, current.content.length - 1);
        continue;
      }

      if (part.type !== "tool-result") continue;
      const index = current.tools.get(part.toolCallId);
      if (index === undefined) continue;
      const target = current.content[index];
      if (target?.type !== "tool") continue;

      const text = toolResultText(part.result);
      target.state = part.isError
        ? {
            status: "error",
            input: target.state.input,
            content: [{ type: "text", text: text || "工具未执行：审批被拒绝或已取消。" }],
            error: { type: "acp", message: text || "工具未执行：审批被拒绝或已取消。" },
          }
        : {
            status: "completed",
            input: target.state.input,
            content: [{ type: "text", text: text || "completed" }],
          };
    }
  }

  for (const update of input.updates) {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (
          user !== undefined &&
          user.messageID !== undefined &&
          update.messageId != null &&
          user.messageID !== update.messageId
        ) {
          flushUser();
        }

        const target = ensureUser();
        if (target.messageID === undefined && update.messageId != null) target.messageID = update.messageId;
        await ingestUserContent(target, update.content);
        break;
      }

      case "agent_message_chunk": {
        flushUser();
        if (
          assistant !== undefined &&
          assistant.messageID !== undefined &&
          update.messageId != null &&
          assistant.messageID !== update.messageId
        ) {
          await flushAssistant();
        }

        const target = ensureAssistant();
        if (target.messageID === undefined && update.messageId != null) target.messageID = update.messageId;
        await ingestAssistantContent(target, update.content);
        break;
      }

      case "agent_thought_chunk": {
        flushUser();
        if (
          assistant !== undefined &&
          assistant.messageID !== undefined &&
          update.messageId != null &&
          assistant.messageID !== update.messageId
        ) {
          await flushAssistant();
        }

        const target = ensureAssistant();
        if (target.messageID === undefined && update.messageId != null) target.messageID = update.messageId;
        if (update.content.type === "text") appendReasoning(target, update.content.text);
        break;
      }

      case "tool_call":
      case "tool_call_update": {
        flushUser();
        const target = ensureAssistant();
        applyParts(target, target.projector.update(update));
        if (update.content === null) target.toolContent.set(update.toolCallId, []);
        else if (update.content !== undefined) target.toolContent.set(update.toolCallId, update.content);
        break;
      }

      case "notice": {
        flushUser();
        await flushAssistant();
        const text = [update.title, update.description]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join("\n");
        if (text.length > 0) messages.push({ id: messageID(), type: "system", text, time: { created: 0 } });
        break;
      }

      case "compaction_summary_chunk": {
        if (update.content.type === "text") {
          compactions.set(update.compactionId, (compactions.get(update.compactionId) ?? "") + update.content.text);
        }
        break;
      }

      case "compaction_update": {
        if (update.summary !== null && update.summary !== undefined) {
          compactions.set(update.compactionId, contentText(update.summary));
        }
        if (update.status === "completed") {
          flushUser();
          await flushAssistant();
          const text = compactions.get(update.compactionId)?.trim() ?? "";
          if (text.length > 0) {
            messages.push({
              id: messageID(),
              type: "compaction",
              status: "completed",
              reason: "auto",
              summary: text,
              time: { created: 0 },
            });
          }
          compactions.delete(update.compactionId);
        }
        break;
      }

      case "usage_update": {
        usage = update.used;
        break;
      }

      case "session_info_update": {
        if (typeof update.title === "string" && update.title.trim().length > 0) title = update.title.trim();
        if (typeof update.updatedAt === "string") updatedAt = update.updatedAt;
        break;
      }

      default:
        break;
    }
  }

  flushUser();
  await flushAssistant();

  const now = Date.now();
  const base = Math.min(now, parseTime(updatedAt) ?? now);
  const start = messages.length > 0 ? Math.max(0, base - messages.length * 1000) : base;

  messages.forEach((message, index) => {
    const created = start + index * 1000;
    message.time.created = created;
    if (message.type !== "assistant") return;

    message.time.completed = created + 500;
    const content = message.content as AssistantPart[];
    for (const part of content) {
      if (part.type === "tool") {
        part.time = { created: created + 100, ran: created + 100, completed: created + 400 };
      }
    }
  });

  const finalTitle = title.length > 0 ? title : fallbackTitle(firstUserText);
  const info: Record<string, unknown> = {
    id: input.opencodeSessionID,
    projectID: "global",
    agent: "build",
    model: input.model,
    cost: 0,
    tokens: {
      input: Number.isFinite(usage) ? Math.max(0, Math.floor(usage)) : 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: start, updated: base, idle: base },
    location: { directory: input.cwd },
    metadata: { acp: { agent: input.agentID, session: input.acpSessionID } },
  };
  if (finalTitle.length > 0) info.title = finalTitle;

  return {
    info,
    messages,
    location: { directory: input.cwd },
    title: finalTitle,
  };
}

function contentText(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource" && "text" in block.resource) return [block.resource.text];
      return [];
    })
    .join("\n");
}

function normalizedMime(mimeHint: string | null | undefined, kind: MediaKind, uri?: string | null): string | undefined {
  const direct = normalizeMediaType(mimeHint, kind);
  if (direct !== undefined) return direct;
  if (uri === undefined || uri === null) return undefined;
  const inferred = mimeFromName(uri);
  return normalizeMediaType(inferred, kind);
}

function decodeMedia(data: string, mimeHint: string): MediaPayload | undefined {
  const text = data.trim();
  let mime = mimeHint;
  let value = text;

  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma < 0) return undefined;

    const header = text.slice(5, comma);
    const parts = header.split(";");
    if (!parts.includes("base64")) return undefined;

    const headerMime = parts[0]?.trim().toLowerCase();
    if (headerMime !== undefined && headerMime.length > 0 && headerMime.split("/")[0] === mime.split("/")[0]) {
      mime = headerMime;
    }
    value = text.slice(comma + 1);
  }

  const base64 = normalizeBase64(value);
  if (base64 === undefined) return undefined;
  return { base64, bytes: base64Bytes(base64), mime };
}

function dataURLMime(value: string): string | undefined {
  const comma = value.indexOf(",");
  if (comma < 0) return undefined;
  const header = value.slice(5, comma);
  if (!header.split(";").includes("base64")) return undefined;
  const mime = header.split(";")[0]?.trim().toLowerCase();
  return mime === undefined || mime.length === 0 ? undefined : mime;
}

function localPath(uri: string): string | undefined {
  const value = uri.trim();
  if (value.startsWith("file:")) {
    try {
      const url = new URL(value);
      if (url.hostname.length > 0 && url.hostname !== "localhost") return undefined;
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(value) ? value : undefined;
}

function fileName(uri: string | null | undefined, mime: string, kind: MediaKind): string {
  const path = uri === undefined || uri === null ? undefined : localPath(uri);
  const name = path === undefined ? undefined : basename(path);
  if (name !== undefined && name.length > 0) return name;
  return `${kind === "image" ? "image" : "audio"}.${extensionFor(mime)}`;
}

function capOf(kind: MediaKind): number {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function label(kind: MediaKind): string {
  return kind === "image" ? "图片" : "音频";
}

function parseToolInput(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return isRecord(value) ? value : { value };
  } catch {
    return { value: input };
  }
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  if (typeof result !== "object") return String(result);

  const record = result as Record<string, unknown>;
  if (typeof record["value"] === "string" && (record["type"] === "text" || record["type"] === "error-text")) {
    return record["value"];
  }
  if (record["type"] === "json") {
    try {
      return JSON.stringify(record["value"]);
    } catch {
      return "";
    }
  }
  if (record["type"] === "content" && Array.isArray(record["value"])) {
    return record["value"]
      .flatMap((item) =>
        isRecord(item) && item["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : [],
      )
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTime(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fallbackTitle(text: string): string {
  const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.slice(0, 60);
}
