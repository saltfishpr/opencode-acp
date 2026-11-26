import { AcpSettings, type PrepareImportResult } from "../../rpc.js";
import type { GuiContext } from "../definition.js";
import type { ImportRowData } from "./model.js";

/** Loads the ACP history, then creates the OpenCode session through the host. */
export async function importSession(
  ctx: GuiContext,
  input: {
    row: ImportRowData;
    signal: AbortSignal;
    close(): void;
    reload(): void;
    fail(message: string): void;
  },
): Promise<void> {
  const { row } = input;

  try {
    const rpc = row.server.client.rpc(AcpSettings);
    const prepared = (await rpc.prepareImport(
      { agentID: row.agentID, sessionID: row.id },
      { signal: AbortSignal.timeout(120_000) },
    )) as PrepareImportResult;

    if (prepared.status !== "ok" || prepared.payload === undefined) {
      input.fail(
        prepared.status === "ok"
          ? ctx.t("import.error.importFailed")
          : prepared.status === "notFound" && prepared.reason === "directoryMissing"
            ? ctx.t("import.error.directoryMissing")
            : ctx.t(`import.error.${prepared.status}`),
      );
      if (prepared.status === "alreadyBound" || prepared.status === "notFound") input.reload();
      return;
    }

    const abort = () =>
      rpc
        .abortImport({ agentID: row.agentID, sessionID: row.id, opencodeSessionID: prepared.sessionID })
        .catch(() => undefined);

    if (input.signal.aborted) {
      await abort();
      return;
    }

    const importer = row.server.client.experimental?.session?.import;
    if (typeof importer !== "function") {
      await abort();
      input.fail(ctx.t("import.error.updateOpenCode"));
      return;
    }

    try {
      await row.server.client.experimental.session.import(prepared.payload as never, {
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      await abort();
      input.fail(ctx.t("import.error.importFailed"));
      return;
    }

    if (input.signal.aborted) return;
    ctx.tabs.open({ server: row.server.id, id: prepared.sessionID }, { focus: true });
    input.close();
  } catch (cause) {
    if (input.signal.aborted) return;
    const type = typeof cause === "object" && cause !== null && "type" in cause ? cause.type : undefined;
    input.fail(
      type === "rpc.method_not_found" ? ctx.t("import.error.updatePlugin") : ctx.t("import.error.requestFailed"),
    );
  }
}
