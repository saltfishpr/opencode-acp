import { Command, Plugin, SettingsPage, Style } from "@opencode/plugin/gui";
import css from "../gui.css?inline";
import { definition } from "./definition.js";
import { ImportSessions } from "./import/index.js";
import sessionsCss from "./import/sessions.css?inline";
import { Settings } from "./settings/index.js";

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Style, `${css}\n${sessionsCss}`);
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
  },
});
