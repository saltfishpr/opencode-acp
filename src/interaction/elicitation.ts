import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";

/**
 * Answers an ACP elicitation without showing a form.
 *
 * OpenCode's plugin API does not expose `session.form`, so M3 declines every
 * elicitation and explains it in the assistant text. A future milestone can
 * replace this with a GUI part without changing the ACP client.
 */
export function declineElicitation(): CreateElicitationResponse {
  return { action: "decline" };
}

/** The session an elicitation belongs to, when it is session-scoped. */
export function elicitationSession(params: CreateElicitationRequest): string | undefined {
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** User-facing explanation injected into the turn so the decline is visible. */
export function elicitationNotice(params: CreateElicitationRequest): string {
  const message = params.message.trim();
  const detail = message.length > 0 ? `：${message}` : "。";
  return `远端 agent 请求补充输入${detail}当前客户端还不支持 ACP 表单，已拒绝该请求（decline）。`;
}
