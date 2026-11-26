import type { ContentBlock } from "@agentclientprotocol/sdk";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUDIO_TYPES, IMAGE_TYPES } from "./mime.js";

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

    const value = normalize(text);
    const prompt = normalize(entry.text);
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
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
