import { usePlugin } from "@opencode/plugin/gui";
import { Index, Show, createSignal } from "solid-js";
import { AGENT_ID, type AgentInput, type AgentView, type MutationResult } from "../../rpc.js";
import { definition } from "../definition.js";

interface EnvRow {
  readonly key: string;
  readonly savedKey?: string;
  readonly value?: string;
}

export function AgentForm(props: {
  preset?: AgentInput;
  agent?: AgentView;
  close(): void;
  save(input: AgentInput): Promise<MutationResult>;
}) {
  const ctx = usePlugin<typeof definition>();
  const initial = props.agent ?? props.preset;
  const [name, setName] = createSignal(initial?.name ?? "");
  const [id, setID] = createSignal(initial?.id ?? "");
  const [command, setCommand] = createSignal(initial?.command ?? "");
  const [args, setArgs] = createSignal([...(initial?.args ?? [])]);
  const [env, setEnv] = createSignal<EnvRow[]>((props.agent?.envKeys ?? []).map((key) => ({ key, savedKey: key })));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<MutationResult>();
  const errorFor = (field: string) => {
    const current = error();
    if (current?.field !== field) return;
    return current.status === "duplicate" ? ctx.t("error.duplicate") : ctx.t(`field.${field}`);
  };

  async function save() {
    if (saving()) return;
    setError(undefined);
    const values = env().map(
      ({ key, savedKey, value }) => [key.trim(), value ?? (key.trim() === savedKey ? null : "")] as const,
    );
    const field = !name().trim()
      ? "name"
      : !AGENT_ID.test(id().trim())
        ? "id"
        : !command().trim()
          ? "command"
          : values.some(([key]) => !key) || new Set(values.map(([key]) => key)).size !== values.length
            ? "env"
            : undefined;
    if (field !== undefined) {
      setError({ status: "invalid", field });
      return;
    }

    setSaving(true);
    try {
      const outcome = await props.save({
        id: id().trim(),
        name: name().trim(),
        command: command().trim(),
        args: args(),
        env: Object.fromEntries(values),
      });
      if (outcome.status === "ok") props.close();
      else setError(outcome);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ctx.ui.Dialog
      title={
        props.agent
          ? ctx.t("editAgent", { name: props.agent.name })
          : props.preset
            ? ctx.t("addPreset", { name: props.preset.name })
            : ctx.t("addCustom")
      }
      footer={
        <>
          <ctx.ui.Button variant="ghost" disabled={saving()} onClick={props.close}>
            {ctx.t("cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button variant="contrast" busy={saving()} onClick={() => void save()}>
            {ctx.t(props.agent ? "save" : "saveEnable")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="acp-agent-form">
        <div class="acp-form-field">
          <label class="acp-form-label">
            {ctx.t("name")}
            <ctx.ui.TextInput
              label={ctx.t("name")}
              size="large"
              value={name()}
              onInput={setName}
              onSubmit={() => void save()}
              invalid={!!errorFor("name")}
              disabled={saving()}
              autofocus
            />
          </label>
          <Show when={errorFor("name")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </div>
        <Show when={!props.preset}>
          <div class="acp-form-field">
            <label class="acp-form-label">
              {ctx.t("id")}
              <ctx.ui.TextInput
                label={ctx.t("id")}
                size="large"
                value={id()}
                onInput={setID}
                onSubmit={() => void save()}
                invalid={!!errorFor("id")}
                disabled={!!props.agent || saving()}
              />
            </label>
            <Show when={errorFor("id")} fallback={<span class="acp-form-hint">{ctx.t("idHint")}</span>}>
              {(text: () => string) => (
                <span class="acp-error" role="alert">
                  {text()}
                </span>
              )}
            </Show>
          </div>
        </Show>
        <div class="acp-form-field">
          <label class="acp-form-label">
            {ctx.t("command")}
            <ctx.ui.TextInput
              label={ctx.t("command")}
              size="large"
              value={command()}
              onInput={setCommand}
              onSubmit={() => void save()}
              invalid={!!errorFor("command")}
              disabled={saving()}
            />
          </label>
          <Show when={errorFor("command")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </div>
        <fieldset class="acp-form-field acp-form-group">
          <legend>{ctx.t("args")}</legend>
          <Index each={args()}>
            {(arg, index) => (
              <div class="acp-form-row">
                <ctx.ui.TextInput
                  label={ctx.t("arg", { number: index + 1 })}
                  size="large"
                  value={arg()}
                  onInput={(value) => setArgs((list) => list.with(index, value))}
                  disabled={saving()}
                />
                <ctx.ui.IconButton
                  icon="trash"
                  label={ctx.t("removeArg", { number: index + 1 })}
                  disabled={saving()}
                  onClick={() => setArgs((list) => list.filter((_, i) => i !== index))}
                />
              </div>
            )}
          </Index>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="plus"
            disabled={saving()}
            onClick={() => setArgs((list) => [...list, ""])}
          >
            {ctx.t("addArg")}
          </ctx.ui.Button>
          <Show when={errorFor("args")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </fieldset>
        <fieldset class="acp-form-field acp-form-group">
          <legend>{ctx.t("env")}</legend>
          <Index each={env()}>
            {(row, index) => (
              <div class="acp-form-row acp-form-row-env">
                <ctx.ui.TextInput
                  label={ctx.t("envKey")}
                  size="large"
                  placeholder={ctx.t("envKey")}
                  value={row().key}
                  onInput={(key) => setEnv((list) => list.with(index, { ...row(), key }))}
                  disabled={saving()}
                />
                <ctx.ui.TextInput
                  label={ctx.t("envValue")}
                  type="password"
                  size="large"
                  placeholder={row().savedKey === row().key ? ctx.t("envSaved") : ctx.t("envValue")}
                  value={row().value ?? ""}
                  onInput={(value) => setEnv((list) => list.with(index, { ...row(), value }))}
                  disabled={saving()}
                />
                <ctx.ui.IconButton
                  icon="trash"
                  label={ctx.t("removeEnv", { number: index + 1 })}
                  disabled={saving()}
                  onClick={() => setEnv((list) => list.filter((_, i) => i !== index))}
                />
              </div>
            )}
          </Index>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="plus"
            disabled={saving()}
            onClick={() => setEnv((list) => [...list, { key: "" }])}
          >
            {ctx.t("addEnv")}
          </ctx.ui.Button>
          <Show when={errorFor("env")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </fieldset>
        <Show when={error()?.field === undefined && error() !== undefined}>
          <span class="acp-error" role="alert">
            {ctx.t(`error.${error()?.status}`)}
          </span>
        </Show>
      </div>
    </ctx.ui.Dialog>
  );
}
