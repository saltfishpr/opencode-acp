import type {
  AgentCapabilities,
  AudioContent,
  ContentBlock,
  EmbeddedResource,
  ImageContent,
  ResourceLink,
  SystemPrompt,
} from "@agentclientprotocol/sdk";

import {
  AcpInvalidArgumentError,
  AcpUnsupportedContentError,
} from "../errors.js";
import type { PromptInput } from "../types/public.js";

export function normalizePrompt(input: PromptInput): ContentBlock[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly ContentBlock[])];
  }
  return [input as ContentBlock];
}

export function validatePromptContent(
  blocks: readonly ContentBlock[],
  capabilities: AgentCapabilities | null,
): void {
  if (blocks.length === 0) {
    throw new AcpInvalidArgumentError("Prompt must contain at least one content block");
  }

  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "resource_link":
        break;
      case "image":
        if (!capabilities?.promptCapabilities?.image) {
          throw new AcpUnsupportedContentError("image", "promptCapabilities.image");
        }
        break;
      case "audio":
        if (!capabilities?.promptCapabilities?.audio) {
          throw new AcpUnsupportedContentError("audio", "promptCapabilities.audio");
        }
        break;
      case "resource":
        if (!capabilities?.promptCapabilities?.embeddedContext) {
          throw new AcpUnsupportedContentError(
            "resource",
            "promptCapabilities.embeddedContext",
          );
        }
        break;
      default:
        throw new AcpUnsupportedContentError(
          String((block as { type?: unknown }).type),
          "a content block type supported by this client",
        );
    }
  }
}

export function validateSystemPrompt(systemPrompt: SystemPrompt | undefined): void {
  if (!systemPrompt) {
    return;
  }
  if (systemPrompt.content.length === 0) {
    throw new AcpInvalidArgumentError("systemPrompt.content must not be empty");
  }
  for (const block of systemPrompt.content) {
    if (block.type !== "text") {
      throw new AcpInvalidArgumentError(
        `systemPrompt only supports text content blocks, received "${block.type}"`,
      );
    }
  }
}

export const content = {
  text(text: string): ContentBlock {
    return { type: "text", text };
  },

  resourceLink(link: Omit<ResourceLink, "type">): ContentBlock {
    return { type: "resource_link", ...link };
  },

  image(image: Omit<ImageContent, "type">): ContentBlock {
    return { type: "image", ...image };
  },

  audio(audio: Omit<AudioContent, "type">): ContentBlock {
    return { type: "audio", ...audio };
  },

  resource(resource: Omit<EmbeddedResource, "type">): ContentBlock {
    return { type: "resource", ...resource };
  },
};
