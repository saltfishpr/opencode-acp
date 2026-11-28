import type { Cleanup, ServerRef } from "@opencode/plugin/gui";
import { createEffect } from "solid-js";
import { AcpRpc, type ElicitationRequestView } from "../rpc.js";
import type { GuiContext } from "./definition.js";
import { retryUnavailable } from "./shared/location.js";

/** How often the bridge re-reads the form the user is filling in. */
const POLL_MS = 500;

/** Matches the server's own wait, so a form cannot outlive its request. */
const FORM_TIMEOUT_MS = 10 * 60_000;

interface FormState {
  readonly status: "pending" | "answered" | "cancelled";
  readonly answer?: Record<string, unknown>;
}

interface FormApi {
  create(input: {
    sessionID: string;
    title: string;
    fields: readonly unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  get(input: { sessionID: string; formID: string }): Promise<{ id: string; state: FormState }>;
  cancel(input: { sessionID: string; formID: string }): Promise<void>;
}

interface Active {
  readonly request: ElicitationRequestView;
  stopped: boolean;
  formID: string | undefined;
}

/**
 * Turns `elicitation` events on each connected server into OpenCode forms.
 *
 * The server cannot create forms, so this Desktop-only bridge claims a request,
 * creates the form in the session, polls until the user answers or cancels it,
 * and reports the outcome back. Without a window the server declines after its
 * claim window, so no agent waits forever.
 */
export function startElicitationBridge(ctx: GuiContext): Cleanup {
  const attached = new Map<string, { client: unknown; dispose: Cleanup }>();

  createEffect(() => {
    const ids = new Set(ctx.servers.list());

    for (const [id, entry] of [...attached]) {
      const server = ctx.servers.get(id);
      if (ids.has(id) && server !== undefined && server.client === entry.client) continue;
      entry.dispose();
      attached.delete(id);
    }

    for (const id of ids) {
      const server = ctx.servers.get(id);
      if (server === undefined || !server.connected || !server.compatible) continue;

      const existing = attached.get(id);
      if (existing?.client === server.client) continue;
      existing?.dispose();
      attached.set(id, { client: server.client, dispose: attach(ctx, server) });
    }
  });

  return () => {
    for (const entry of attached.values()) entry.dispose();
    attached.clear();
  };
}

function attach(ctx: GuiContext, server: ServerRef): Cleanup {
  const rpc = server.client.rpc(AcpRpc);
  const form = () => (server.client as unknown as { session: { form: FormApi } }).session.form;
  const active = new Map<string, Active>();

  const cancelForm = async (state: Active): Promise<void> => {
    if (state.formID === undefined) return;
    const formID = state.formID;
    state.formID = undefined;
    try {
      await form().cancel({ sessionID: state.request.sessionID, formID });
    } catch {
      // The form is already answered or the session went away.
    }
  };

  const settle = async (
    request: ElicitationRequestView,
    action: "accept" | "cancel" | "decline",
    content?: Record<string, unknown>,
  ) => {
    try {
      await rpc.answerElicitation(
        {
          requestID: request.requestID,
          action,
          ...(content === undefined ? {} : { content }),
        },
        { location: { directory: request.directory } },
      );
    } catch {
      // The server already gave up on this request.
    }
  };

  const handle = async (request: ElicitationRequestView): Promise<void> => {
    if (active.has(request.requestID)) return;

    const state: Active = { request, stopped: false, formID: undefined };
    active.set(request.requestID, state);

    try {
      const claimed = await rpc.claimElicitation(
        { requestID: request.requestID },
        { location: { directory: request.directory } },
      );
      if (!claimed.claimed) return;

      const created = await form().create({
        sessionID: request.sessionID,
        title: ctx.t("elicitation.title", { agent: request.agentName }),
        fields: request.fields,
        metadata: {
          kind: "acp-elicitation",
          requestID: request.requestID,
          ...(request.message === undefined ? {} : { message: request.message }),
        },
      });
      state.formID = created.id;
      await rpc.elicitationForm(
        { requestID: request.requestID, formID: created.id },
        { location: { directory: request.directory } },
      );

      const deadline = Date.now() + FORM_TIMEOUT_MS;
      while (!state.stopped && Date.now() < deadline) {
        await pause(POLL_MS);
        if (state.stopped) break;

        let detail;
        try {
          detail = await form().get({ sessionID: request.sessionID, formID: created.id });
        } catch {
          break;
        }
        if (state.stopped) break;

        if (detail.state.status === "answered") {
          state.formID = undefined;
          await settle(request, "accept", detail.state.answer ?? {});
          return;
        }

        if (detail.state.status === "cancelled") {
          state.formID = undefined;
          await settle(request, "cancel");
          return;
        }
      }

      if (state.stopped) return;
      await cancelForm(state);
      await settle(request, "cancel");
    } catch (error) {
      console.warn(`[acp] elicitation form failed: ${error instanceof Error ? error.message : String(error)}`);
      await cancelForm(state);
      await settle(request, "decline");
    } finally {
      active.delete(request.requestID);
    }
  };

  const offRequest = rpc.events.on("elicitation", (event) => {
    void handle(event.data);
  });

  const offCancelled = rpc.events.on("elicitationCancelled", (event) => {
    const { requestID } = event.data;
    const state = active.get(requestID);
    if (state === undefined) return;

    state.stopped = true;
    active.delete(requestID);
    void cancelForm(state);
    void settle(state.request, "cancel");
  });

  // A window opened after a request arrived still shows it. Pending requests
  // live in the plugin instance for their location, so query each known one.
  void (async () => {
    const directories = new Set<string>();
    const activeSession = ctx.sessions.current();
    if (activeSession?.location !== undefined) directories.add(activeSession.location.directory);
    for (const session of ctx.sessions.list()) {
      if (session.location !== undefined) directories.add(session.location.directory);
    }

    const requests = new Map<string, ElicitationRequestView>();
    const collect = async (directory: string | undefined): Promise<void> => {
      try {
        const result = await retryUnavailable(() =>
          directory === undefined
            ? rpc.pendingElicitations({})
            : rpc.pendingElicitations({}, { location: { directory } }),
        );
        for (const request of result.requests) {
          requests.set(request.requestID, request);
        }
      } catch (error) {
        console.warn(
          `[acp] could not read pending elicitations: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    if (directories.size === 0) await collect(undefined);
    else await Promise.all([...directories].map((directory) => collect(directory)));
    for (const request of requests.values()) void handle(request);
  })();

  return () => {
    offRequest();
    offCancelled();
    for (const state of [...active.values()]) {
      state.stopped = true;
      void cancelForm(state);
      void settle(state.request, "cancel");
    }
    active.clear();
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
