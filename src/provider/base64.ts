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
