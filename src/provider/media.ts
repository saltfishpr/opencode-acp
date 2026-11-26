import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../log.js";
import { normalizeBase64 } from "./base64.js";

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

const EXTENSIONS: Record<"image" | "audio", Readonly<Record<string, string>>> = {
  image: {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  },
  audio: {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/aac": "aac",
    "audio/flac": "flac",
  },
};

export type AgentMediaKind = "image" | "audio";

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
  kind: AgentMediaKind,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined;

  const type = mimeType.trim().toLowerCase();
  if (!type.startsWith(`${kind}/`)) return undefined;

  const base64 = normalizeBase64(data);
  if (base64 === undefined) return undefined;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > CAPS[kind]) return undefined;

  const extension = EXTENSIONS[kind][type] ?? "bin";
  const directory = join(tmpdir(), "opencode", "opencode-acp", DIRECTORIES[kind], sessionID);
  const file = join(directory, `${crypto.randomUUID()}.${extension}`);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, bytes);
    return file;
  } catch (error) {
    logWarn("acp", `could not save agent ${kind}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function saveAgentImage(sessionID: string, data: string, mimeType: string): Promise<string | undefined> {
  return saveAgentMedia(sessionID, data, mimeType, "image");
}

export function saveAgentAudio(sessionID: string, data: string, mimeType: string): Promise<string | undefined> {
  return saveAgentMedia(sessionID, data, mimeType, "audio");
}
