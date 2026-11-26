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
