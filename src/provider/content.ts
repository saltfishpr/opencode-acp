import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  LanguageModelV3DataContent,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";

/** Common image APIs cap one image at 5 MB; larger payloads make one NDJSON line the agent must read. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The latest user message, converted to ACP content blocks. */
export interface PromptContent {
  /** Blocks in the order the user wrote them. */
  readonly blocks: ContentBlock[];
  /** Why a part was left out, phrased for the assistant message. */
  readonly warnings: string[];
}

/**
 * Converts the latest user message to ACP content blocks.
 *
 * Only images are forwarded as attachments; other file parts are dropped with a
 * warning because the provider does not advertise them as inputs.
 */
export function lastUserPrompt(prompt: LanguageModelV3Prompt): PromptContent {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index];
    if (message?.role !== "user") continue;
    return build(message.content);
  }
  return { blocks: [], warnings: [] };
}

function build(content: Array<LanguageModelV3TextPart | LanguageModelV3FilePart>): PromptContent {
  const blocks: ContentBlock[] = [];
  const oversized: string[] = [];
  const unreadable: string[] = [];
  const unsupported: string[] = [];
  let text: string[] = [];

  // Adjacent text parts become one block, joined the way the text-only path
  // used to join them, so adding an image does not change the surrounding text.
  const flushText = () => {
    const joined = text.join("\n").trim();
    if (joined.length > 0) blocks.push({ type: "text", text: joined });
    text = [];
  };

  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }

    flushText();

    const declared = part.mediaType.trim().toLowerCase();
    if (!declared.startsWith("image/")) {
      unsupported.push(attachmentName(part));
      continue;
    }

    const payload = decode(part.data);
    if (payload === undefined) {
      unreadable.push(attachmentName(part));
      continue;
    }

    const mimeType = imageMediaType(declared, part, payload);
    if (mimeType === undefined) {
      unreadable.push(attachmentName(part));
      continue;
    }

    if (payload.bytes > MAX_IMAGE_BYTES) {
      oversized.push(attachmentName(part));
      continue;
    }

    blocks.push({ type: "image", data: payload.base64, mimeType });
  }

  flushText();
  return { blocks, warnings: warningsOf(oversized, unreadable, unsupported) };
}

function warningsOf(oversized: string[], unreadable: string[], unsupported: string[]): string[] {
  const warnings: string[] = [];
  if (oversized.length > 0) warnings.push(`已忽略图片 ${list(oversized)}：超过 5 MB。`);
  if (unreadable.length > 0) warnings.push(`已忽略图片 ${list(unreadable)}：无法读取图片数据。`);
  if (unsupported.length > 0) warnings.push(`已忽略附件 ${list(unsupported)}：只转发图片附件。`);
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

function normalizeImageType(value: string): string | undefined {
  const type = value.trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return type.startsWith("image/") && type !== "image/*" ? type : undefined;
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

/** Returns padded base64, or undefined for content the agent would fail to decode. */
function normalizeBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 === 1) return undefined;

  const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), "=");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(padded) ? padded : undefined;
}

function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
