import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Style,
  type MenuItem as MenuItemType,
  type PanelTab,
} from "@opencode/plugin/gui";
import css from "../gui.css?inline";
import { createSessionCommands } from "./client/commands.js";
import { isAcpSession } from "./client/session.js";
import { definition } from "./definition.js";
import { startElicitationBridge } from "./elicitation/bridge.js";
import { ImportSessions } from "./import/index.js";
import sessionsCss from "./import/sessions.css?inline";
import { SessionOptions } from "./panel/session-options.js";
import { Settings } from "./settings/index.js";

export default Plugin.define({
  ...definition,
  setup(ctx) {
    const stopElicitations = startElicitationBridge(ctx);
    ctx.add(Style, `${css}\n${sessionsCss}`);
    createSessionCommands(ctx);

    const optionsTab: PanelTab = {
      id: "options",
      get title() {
        return ctx.t("session.title");
      },
      closable: "hover",
    };
    const optionsKey = `${ctx.id}:${optionsTab.id}`;
    const acpSession = () => {
      const session = ctx.sessions.current();
      return session !== undefined && isAcpSession(session) ? session : undefined;
    };
    const openOptions = () => {
      const session = acpSession();
      if (session !== undefined) ctx.layout.open(optionsKey, session);
    };

    ctx.add(Panel, {
      id: "session",
      region: "side",
      width: "narrow",
      mobile: {
        get title() {
          return ctx.t("session.title");
        },
        icon: "sliders",
        kind: "tab",
        order: 0,
      },
      list: (input) => (input.open.includes(optionsTab.id) && isAcpSession(input.session) ? [optionsTab] : []),
      render: (props) => <SessionOptions session={props.session} />,
    });
    ctx.add(MenuItem, (): MenuItemType | undefined => {
      const session = acpSession();
      if (session === undefined) return undefined;

      return {
        menu: "session.panel",
        id: "session-options",
        get title() {
          return ctx.t("session.open");
        },
        icon: "sliders",
        get opened() {
          return ctx.layout.state(optionsKey, session) !== "closed";
        },
        run: openOptions,
      };
    });
    ctx.add(Command, () => ({
      id: "session-options",
      get title() {
        return ctx.t("session.open");
      },
      get description() {
        return ctx.t("session.openDescription");
      },
      keywords: "ACP session options 会话 选项 模式 命令",
      get group() {
        return ctx.t("title");
      },
      get enabled() {
        return acpSession() !== undefined;
      },
      run: openOptions,
    }));
    ctx.add(Command, () => ({
      id: "import-session",
      get title() {
        return ctx.t("import.command");
      },
      get description() {
        return ctx.t("import.commandDescription");
      },
      keywords: "ACP import session 导入 会话",
      get group() {
        return ctx.t("title");
      },
      run() {
        ctx.dialogs.open((dialog) => <ImportSessions close={dialog.close} />);
      },
    }));
    ctx.add(SettingsPage, {
      id: "acp",
      get title() {
        return ctx.t("title");
      },
      get entries() {
        return [{ id: "acp-log", title: ctx.t("logLevel"), keywords: "ACP log level" }];
      },
      render: () => <Settings />,
    });

    return stopElicitations;
  },
});
