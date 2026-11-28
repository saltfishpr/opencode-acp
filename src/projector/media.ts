import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  LanguageModelV3DataContent,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import { logWarn } from "../log.js";

/** Returns padded base64, or undefined for input that would decode to garbage. */
export function normalizeBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 === 1) return undefined;

  const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), "=");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(padded) ? padded : undefined;
}

/** Decoded byte length of normalized base64. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
  flac: "audio/flac",
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

export type MediaKind = "image" | "audio";

export function normalizeImageType(value: string): string | undefined {
  const type = value.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return type.startsWith("image/") && type !== "image/*" ? type : undefined;
}

export function normalizeAudioType(value: string): string | undefined {
  const type = value.trim().toLowerCase();
  if (type === "audio/mp3") return "audio/mpeg";
  if (type === "audio/x-wav" || type === "audio/wave") return "audio/wav";
  if (type === "audio/x-m4a" || type === "audio/m4a") return "audio/mp4";
  return type.startsWith("audio/") && type !== "audio/*" ? type : undefined;
}

export function normalizeMediaType(value: string | null | undefined, kind: MediaKind): string | undefined {
  if (value === undefined || value === null) return undefined;
  return kind === "image" ? normalizeImageType(value) : normalizeAudioType(value);
}

export function mediaKind(value: string | null | undefined): MediaKind | undefined {
  if (value === undefined || value === null) return undefined;
  const type = value.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return undefined;
}

export function mimeFromName(name: string): string | undefined {
  const clean = name.split(/[?#]/, 1)[0] ?? "";
  const extension = clean.split(".").pop()?.toLowerCase();
  if (extension === undefined) return undefined;
  return IMAGE_TYPES[extension] ?? AUDIO_TYPES[extension];
}

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.trim().toLowerCase()] ?? "bin";
}

/** Common image APIs cap one image at 5 MB; larger payloads make one NDJSON line the agent must read. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Audio files are larger than images; keep the base64 payload bounded as well. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const CAPS = {
  image: MAX_IMAGE_BYTES,
  audio: MAX_AUDIO_BYTES,
} as const;

const DIRECTORIES = {
  image: "images",
  audio: "audio",
} as const;

/**
 * Writes media from an agent message under the server's temporary directory and
 * returns its absolute path.
 *
 * OpenCode's temp directory is `os.tmpdir()/opencode`, which keeps the file on
 * the machine that runs the agent. Returns undefined when the payload is
 * unusable or the MIME type does not match `kind`.
 */
export async function saveAgentMedia(
  sessionID: string,
  data: string,
  mimeType: string,
  kind: MediaKind,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined;

  const raw = mimeType.trim().toLowerCase();
  const type = kind === "image" ? normalizeImageType(raw) : normalizeAudioType(raw);
  if (type === undefined) return undefined;

  const base64 = normalizeBase64(data);
  if (base64 === undefined) return undefined;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > CAPS[kind]) return undefined;

  const extension = extensionFor(type);
  const directory = join(tmpdir(), "opencode", "opencode-acp", DIRECTORIES[kind], sessionID);
  const file = join(directory, `${crypto.randomUUID()}.${extension}`);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, bytes);
    return file;
  } catch (error) {
    logWarn("acp", `could not save agent ${kind}: ${message(error)}`);
    return undefined;
  }
}

export function saveAgentImage(sessionID: string, data: string, mimeType: string): Promise<string | undefined> {
  return saveAgentMedia(sessionID, data, mimeType, "image");
}

export function saveAgentAudio(sessionID: string, data: string, mimeType: string): Promise<string | undefined> {
  return saveAgentMedia(sessionID, data, mimeType, "audio");
}

/** The latest user message, converted to ACP content blocks. */
export interface PromptContent {
  /** Blocks in the order the user wrote them. */
  readonly blocks: ContentBlock[];
  /** Text of the message after joining adjacent text parts, used to match its attachments. */
  readonly text: string;
  /** Why a part was left out, phrased for the assistant message. */
  readonly warnings: string[];
}

/**
 * Converts the latest user message to ACP content blocks.
 *
 * Images and audio are forwarded as attachments; other file parts are dropped
 * with a warning because the provider does not advertise them as inputs.
 */
export function lastUserPrompt(prompt: LanguageModelV3Prompt): PromptContent {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    if (message?.role !== "user") continue;
    return buildPrompt(message.content);
  }
  return { blocks: [], text: "", warnings: [] };
}

function buildPrompt(content: Array<LanguageModelV3TextPart | LanguageModelV3FilePart>): PromptContent {
  const blocks: ContentBlock[] = [];
  const oversizedImages: string[] = [];
  const oversizedAudio: string[] = [];
  const unreadable: string[] = [];
  const unsupported: string[] = [];
  const texts: string[] = [];
  let text: string[] = [];

  // Adjacent text parts become one block, joined the way the text-only path
  // used to join them, so adding an image does not change the surrounding text.
  const flushText = () => {
    const joined = text.join("\n").trim();
    if (joined.length > 0) {
      blocks.push({ type: "text", text: joined });
      texts.push(joined);
    }
    text = [];
  };

  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }

    flushText();

    const declared = part.mediaType.trim().toLowerCase();
    const kind = declared.startsWith("image/") ? "image" : declared.startsWith("audio/") ? "audio" : undefined;
    if (kind === undefined) {
      unsupported.push(attachmentName(part));
      continue;
    }

    const payload = decode(part.data);
    if (payload === undefined) {
      unreadable.push(attachmentName(part));
      continue;
    }

    const mimeType =
      kind === "image" ? imageMediaType(declared, part, payload) : audioMediaType(declared, part, payload);
    if (mimeType === undefined) {
      unreadable.push(attachmentName(part));
      continue;
    }

    if (payload.bytes > (kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) {
      (kind === "image" ? oversizedImages : oversizedAudio).push(attachmentName(part));
      continue;
    }

    if (kind === "image") blocks.push({ type: "image", data: payload.base64, mimeType });
    else blocks.push({ type: "audio", data: payload.base64, mimeType });
  }

  flushText();
  return {
    blocks,
    text: texts.join("\n"),
    warnings: warningsOf(oversizedImages, oversizedAudio, unreadable, unsupported),
  };
}

function warningsOf(
  oversizedImages: string[],
  oversizedAudio: string[],
  unreadable: string[],
  unsupported: string[],
): string[] {
  const warnings: string[] = [];
  if (oversizedImages.length > 0) warnings.push(`已忽略图片 ${list(oversizedImages)}：超过 5 MB。`);
  if (oversizedAudio.length > 0) warnings.push(`已忽略音频 ${list(oversizedAudio)}：超过 20 MB。`);
  if (unreadable.length > 0) warnings.push(`已忽略附件 ${list(unreadable)}：无法读取附件数据。`);
  if (unsupported.length > 0)
    warnings.push(`附件 ${list(unsupported)} 仅在 URI 可用时通过 ACP 资源转发，否则会被忽略。`);
  return warnings;
}

function list(names: readonly string[]): string {
  const shown = names.slice(0, 3).join("、");
  return names.length > 3 ? `${shown} 等 ${names.length} 个` : shown;
}

function attachmentName(file: LanguageModelV3FilePart): string {
  return file.filename?.trim() || "未命名附件";
}

/** Accepts concrete image types; `image/*` falls back to the filename or data URL header. */
function imageMediaType(declared: string, file: LanguageModelV3FilePart, payload: Payload): string | undefined {
  if (declared !== "image/*") return normalizeImageType(declared);

  const extension = file.filename?.split(".").pop()?.toLowerCase();
  const byName = extension === undefined ? undefined : IMAGE_TYPES[extension];
  if (byName !== undefined) return byName;

  return payload.mimeType === undefined ? undefined : normalizeImageType(payload.mimeType);
}

/** Accepts concrete audio types; `audio/*` falls back to the filename or data URL header. */
function audioMediaType(declared: string, file: LanguageModelV3FilePart, payload: Payload): string | undefined {
  if (declared !== "audio/*" && declared !== "audio") return normalizeAudioType(declared);

  const extension = file.filename?.split(".").pop()?.toLowerCase();
  const byName = extension === undefined ? undefined : AUDIO_TYPES[extension];
  if (byName !== undefined) return byName;

  return payload.mimeType === undefined ? undefined : normalizeAudioType(payload.mimeType);
}

interface Payload {
  readonly base64: string;
  readonly bytes: number;
  /** MIME type carried by a data URL, when it has one. */
  readonly mimeType?: string;
}

/** Reads base64 bytes from the forms a file part can carry; URL fetching is left to the SDK. */
function decode(data: LanguageModelV3DataContent): Payload | undefined {
  if (data instanceof Uint8Array) {
    return { base64: Buffer.from(data).toString("base64"), bytes: data.byteLength };
  }

  const value = data instanceof URL ? (data.protocol === "data:" ? data.href : undefined) : data;
  if (value === undefined) return undefined;

  const text = value.trim();
  if (text.startsWith("data:")) return decodeDataURL(text);
  return payloadOf(text);
}

function decodeDataURL(value: string): Payload | undefined {
  const comma = value.indexOf(",");
  if (comma < 0) return undefined;

  const header = value.slice(5, comma);
  if (!header.split(";").includes("base64")) return undefined;

  const mimeType = header.split(";")[0]?.trim().toLowerCase();
  return payloadOf(value.slice(comma + 1), mimeType === undefined || mimeType.length === 0 ? undefined : mimeType);
}

function payloadOf(value: string, mimeType?: string): Payload | undefined {
  const base64 = normalizeBase64(value);
  if (base64 === undefined) return undefined;

  return {
    base64,
    bytes: base64Bytes(base64),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

/** One attachment from the user's prompt, as OpenCode reports it. */
export interface PromptFile {
  readonly uri: string;
  readonly source?: { readonly type: "inline" } | { readonly type: "uri"; readonly uri: string };
  readonly name?: string;
  readonly description?: string;
}

/** Largest text file read into a `resource` block; bigger files stay links. */
const MAX_EMBEDDED_BYTES = 1024 * 1024;

/** Bound on remembered prompts so the map cannot grow with abandoned sessions. */
const REMEMBER_LIMIT = 500;

/** Text extensions that can be embedded as a resource instead of a link. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/x-python",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cc: "text/x-c++",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  sql: "application/sql",
  graphql: "application/graphql",
  ini: "text/plain",
  conf: "text/plain",
  env: "text/plain",
};

/**
 * Remembers the files attached to the latest user prompt of each session.
 *
 * Model requests also run for titles and compaction. Only the request whose
 * text matches the remembered prompt gets its files, so an attachment is never
 * forwarded twice or attached to an auxiliary request.
 */
export class PromptFiles {
  private readonly latest = new Map<string, { readonly text: string; readonly files: readonly PromptFile[] }>();

  remember(sessionID: string, text: string, files: readonly PromptFile[] | undefined): void {
    if (files === undefined || files.length === 0) {
      this.latest.delete(sessionID);
      return;
    }

    this.latest.set(sessionID, {
      text: text.trim(),
      files: files.map((file) => ({ ...file })),
    });

    if (this.latest.size > REMEMBER_LIMIT) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
  }

  /** Files for this session, only when the request text still matches the prompt. */
  get(sessionID: string, text: string): readonly PromptFile[] | undefined {
    const entry = this.latest.get(sessionID);
    if (entry === undefined) return undefined;

    const value = normalizeSpace(text);
    const prompt = normalizeSpace(entry.text);
    if (value === prompt) return entry.files;

    // OpenCode appends each attachment after the prompt text as an
    // "Attached file: …" section, so the model request is longer than the
    // prompt the hook recorded. Compare the prompt as a prefix instead of
    // requiring equality.
    if (prompt.length === 0) return value.startsWith("Attached file:") ? entry.files : undefined;
    if (value.startsWith(`${prompt} `)) return entry.files;
    return undefined;
  }

  clear(sessionID: string): void {
    this.latest.delete(sessionID);
  }
}

export interface ResourceBlocksOptions {
  /** Session working directory, used to resolve relative paths. */
  readonly cwd: string;
  /** Whether the agent accepts embedded `resource` content. */
  readonly embedded: boolean;
}

export interface ResourceBlocks {
  readonly blocks: readonly ContentBlock[];
  readonly warnings: readonly string[];
}

/**
 * Converts prompt attachments to ACP resource blocks.
 *
 * Images and audio are already sent by the AI SDK as `image` / `audio` parts,
 * so their files are skipped here. Everything else becomes a `resource_link`,
 * or an embedded text `resource` when the agent advertises `embeddedContext`.
 * A file that cannot be read or does not have a usable URI is reported and
 * skipped; it never fails the turn.
 */
export async function buildResourceBlocks(
  files: readonly PromptFile[],
  options: ResourceBlocksOptions,
): Promise<ResourceBlocks> {
  const blocks: ContentBlock[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const label = file.name?.trim() || file.uri;

    // Images and audio already travel as their own blocks.
    if (isMediaFile(file)) continue;

    if (file.source?.type === "inline") {
      warnings.push(`已跳过附件 ${label}：内联内容无法作为 ACP 资源转发。`);
      continue;
    }

    const raw = file.source?.type === "uri" && file.source.uri.length > 0 ? file.source.uri : file.uri;
    const resolved = resolveResourceUri(raw, options.cwd);
    if ("skip" in resolved) {
      warnings.push(
        resolved.skip === "inline"
          ? `已跳过附件 ${label}：内联内容无法作为 ACP 资源转发。`
          : `已跳过附件 ${label}：只转发本地文件和 http(s) 链接。`,
      );
      continue;
    }

    const uri = resolved.uri;
    if (seen.has(uri)) continue;
    seen.add(uri);

    if (isMedia(uri)) continue;

    const name = nameOf(file, uri);
    const embedded = options.embedded ? await embedText(uri, name, warnings) : undefined;
    if (embedded !== undefined) {
      blocks.push(embedded);
      continue;
    }

    blocks.push({
      type: "resource_link",
      uri,
      name,
      ...(file.description === undefined ? {} : { description: file.description }),
    });
  }

  return { blocks, warnings };
}

type ResolvedUri = { readonly uri: string } | { readonly skip: "inline" | "unsupported" };

function resolveResourceUri(value: string, cwd: string): ResolvedUri {
  const text = value.trim();
  if (text.length === 0) return { skip: "unsupported" };

  if (isAbsolute(text)) return { uri: pathToFileURL(text).href };

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === "file" || scheme === "http" || scheme === "https") return { uri: text };
    if (scheme === "data") return { skip: "inline" };
    return { skip: "unsupported" };
  }

  return { uri: pathToFileURL(resolve(cwd, text)).href };
}

/** Images and audio travel as their own content blocks, not as resources. */
function isMediaFile(file: PromptFile): boolean {
  const name = file.name?.trim() ?? "";
  const source = file.source?.type === "uri" ? file.source.uri : undefined;
  const extension =
    extensionOf(name) ?? extensionOf(file.uri) ?? (source === undefined ? undefined : extensionOf(source));
  if (extension !== undefined) {
    if (IMAGE_TYPES[extension] !== undefined || AUDIO_TYPES[extension] !== undefined) return true;
  }

  return /^data:(image|audio)\//i.test(file.uri) || (source !== undefined && /^data:(image|audio)\//i.test(source));
}

/** Images and audio travel as their own content blocks, not as resources. */
function isMedia(uri: string): boolean {
  const extension = extensionOf(uri);
  return extension !== undefined && (IMAGE_TYPES[extension] !== undefined || AUDIO_TYPES[extension] !== undefined);
}

async function embedText(uri: string, name: string, warnings: string[]): Promise<ContentBlock | undefined> {
  if (!uri.startsWith("file:")) return undefined;

  const extension = extensionOf(uri);
  const mimeType = extension === undefined ? undefined : TEXT_TYPES[extension];
  if (mimeType === undefined) return undefined;

  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch (error) {
    warnings.push(`无法读取附件 ${name}，已改为资源链接：${message(error)}`);
    return undefined;
  }

  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_EMBEDDED_BYTES) return undefined;

    const text = await readFile(path, "utf8");
    return { type: "resource", resource: { uri, text, mimeType } };
  } catch (error) {
    warnings.push(`无法读取附件 ${name}，已改为资源链接：${message(error)}`);
    return undefined;
  }
}

function extensionOf(uri: string): string | undefined {
  const path = filePathOf(uri) ?? uri;
  const clean = path.split(/[?#]/, 1)[0] ?? "";
  const extension = extname(clean).slice(1).toLowerCase();
  return extension.length > 0 ? extension : undefined;
}

function filePathOf(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function nameOf(file: PromptFile, uri: string): string {
  const explicit = file.name?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const path = filePathOf(uri);
  if (path !== undefined) {
    const name = basename(path);
    if (name.length > 0) return name;
  }

  try {
    const name = basename(new URL(uri).pathname);
    if (name.length > 0) return name;
  } catch {
    // Not a parseable URL: show the URI itself.
  }
  return uri;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collapses whitespace differences between the hook and the model request. */
function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
