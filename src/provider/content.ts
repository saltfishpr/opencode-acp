import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  LanguageModelV3DataContent,
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import { base64Bytes, normalizeBase64 } from "./base64.js";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES } from "./media.js";
import { AUDIO_TYPES, IMAGE_TYPES, normalizeAudioType, normalizeImageType } from "./mime.js";

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
 * Images and audio are forwarded as attachments; other file parts are dropped
 * with a warning because the provider does not advertise them as inputs.
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
  const oversizedImages: string[] = [];
  const oversizedAudio: string[] = [];
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
  if (unsupported.length > 0) warnings.push(`已忽略附件 ${list(unsupported)}：只转发图片和音频附件。`);
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
