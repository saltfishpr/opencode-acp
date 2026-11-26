import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../log.js";
import { normalizeBase64 } from "./base64.js";

/** An agent image is written to disk, so cap it like an input image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Writes an image from an agent message under the server's temporary directory
 * and returns its absolute path, so a reply can point the user at the file.
 *
 * Returns undefined when the payload is unusable. OpenCode's temp directory is
 * `os.tmpdir()/opencode`, which keeps the file on the machine that runs the agent.
 */
export async function saveAgentImage(sessionID: string, data: string, mimeType: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined;

  const base64 = normalizeBase64(data);
  if (base64 === undefined) return undefined;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;

  const extension = EXTENSIONS[mimeType.trim().toLowerCase()] ?? "bin";
  const directory = join(tmpdir(), "opencode", "opencode-acp", "images", sessionID);
  const file = join(directory, `${crypto.randomUUID()}.${extension}`);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, bytes);
    return file;
  } catch (error) {
    logWarn("acp", `could not save an agent image: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
