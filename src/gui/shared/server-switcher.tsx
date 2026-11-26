import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { usePlugin, type ServerRef } from "@opencode/plugin/gui";
import { For, Show } from "solid-js";
import { definition } from "../definition.js";

export function ServerSwitcher(props: { ids: readonly string[]; selected?: string; onSelect(id: string): void }) {
  const ctx = usePlugin<typeof definition>();
  const server = () => ctx.servers.get(props.selected ?? "");
  const status = (server: ServerRef | undefined) => {
    if (server?.compatible === false) return "incompatible";
    return server?.connected ? "online" : "offline";
  };
  const statusText = (server: ServerRef | undefined) => {
    const state = status(server);
    if (state === "incompatible") return ctx.t("serverIncompatible");
    return state === "offline" ? ctx.t("unreachable") : undefined;
  };

  // The SDK's Menu only accepts text and leading icons. Use the same primitive as Providers for radio rows.
  return (
    <DropdownMenu placement="bottom-end" gutter={6} modal={false}>
      <DropdownMenu.Trigger
        class="acp-server-switcher"
        data-component="button-v2"
        data-variant="outline"
        data-size="small"
      >
        <span class="acp-server-dot" data-status={status(server())} aria-hidden="true" />
        <span class="acp-server-label">{ctx.t("server")}</span>
        <bdi class="acp-server-name">{server()?.name ?? props.selected}</bdi>
        <Show when={statusText(server())}>{(text: () => string) => <span class="sr-only">{text()}</span>}</Show>
        <ctx.ui.Icon name="chevron-down" class="acp-server-chevron" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="acp-server-menu" data-component="menu-v2-content" data-appearance="compact">
          <DropdownMenu.RadioGroup value={props.selected} onChange={props.onSelect}>
            <For each={props.ids}>
              {(id) => {
                const option = () => ctx.servers.get(id);
                const name = () => option()?.name ?? id;
                return (
                  <DropdownMenu.RadioItem
                    value={id}
                    textValue={name()}
                    closeOnSelect
                    data-component="menu-v2-item"
                    data-appearance="compact"
                  >
                    <span data-slot="menu-v2-item-content">
                      <span class="acp-server-dot" data-status={status(option())} aria-hidden="true" />
                      <span class="acp-server-option">
                        <bdi class="acp-server-name">{name()}</bdi>
                        <Show when={option()?.builtin}>
                          <span class="acp-server-label">· {ctx.t("thisComputer")}</span>
                        </Show>
                      </span>
                      <Show when={statusText(option())}>
                        {(text: () => string) => <span class="acp-server-status">{text()}</span>}
                      </Show>
                    </span>
                    <DropdownMenu.ItemIndicator forceMount data-slot="menu-v2-item-indicator">
                      <ctx.ui.Icon name="check" size="small" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              }}
            </For>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator data-slot="menu-v2-separator" data-appearance="compact" />
          <DropdownMenu.Item
            data-component="menu-v2-item"
            data-appearance="compact"
            onSelect={() => ctx.layout.settings("servers")}
          >
            <span data-slot="menu-v2-item-content">
              <ctx.ui.Icon name="server" class="acp-server-chevron" />
              {ctx.t("manageServers")}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
