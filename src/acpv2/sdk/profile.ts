import * as stable from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";

export interface SdkProfile {
  readonly name: "stable" | "unstable";
  readonly PROTOCOL_VERSION: number;
  createApp(name: string): acp.ClientApp;
  createStream(
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>,
    options?: acp.NdJsonStreamOptions,
  ): acp.Stream;
}

export const stableProfile: SdkProfile = {
  name: "stable",
  PROTOCOL_VERSION: stable.PROTOCOL_VERSION,
  createApp: (name) => stable.client({ name }),
  createStream: (output, input, options) => stable.ndJsonStream(output, input, options),
};

/**
 * unstable profile 只在 experimental.unstable 启用时动态加载，
 * 保证 stable 路径不会把 unstable schema 带进运行时代码。
 */
export async function loadUnstableProfile(): Promise<SdkProfile> {
  const unstable = await import("@agentclientprotocol/sdk/unstable");
  return {
    name: "unstable",
    PROTOCOL_VERSION: unstable.PROTOCOL_VERSION,
    createApp: (name) => unstable.client({ name }) as unknown as acp.ClientApp,
    createStream: (output, input, options) =>
      unstable.ndJsonStream(output, input, options) as unknown as acp.Stream,
  };
}
