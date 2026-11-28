import { ComposerPill, Command, Plugin, SettingsPage, Style } from "@opencode/plugin/gui";
import css from "../gui.css?inline";
import { createSessionCommands } from "./commands.js";
import { definition } from "./definition.js";
import { startElicitationBridge } from "./elicitation.js";
import { createSessionHydrator } from "./hydrator.js";
import { createSessionPill } from "./pill/session-pill.js";
import { OpenSessions } from "./sessions/index.js";
import sessionsCss from "./sessions/sessions.css?inline";
import { Settings } from "./settings/index.js";

export default Plugin.define({
  ...definition,
  setup(ctx) {
    const hydrator = createSessionHydrator(ctx);
    const stopElicitations = startElicitationBridge(ctx);
    ctx.add(Style, `${css}\n${sessionsCss}`);
    createSessionCommands(ctx);
    ctx.add(ComposerPill, createSessionPill(ctx, hydrator));
    ctx.add(Command, {
      id: "open-session",
      get title() {
        return ctx.t("sessions.command");
      },
      get description() {
        return ctx.t("sessions.commandDescription");
      },
      keywords: "ACP open continue session 打开 继续 会话",
      get group() {
        return ctx.t("title");
      },
      run() {
        ctx.dialogs.open((dialog) => <OpenSessions hydrator={hydrator} close={dialog.close} />);
      },
    });
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

    return () => {
      stopElicitations();
      hydrator.dispose();
    };
  },
});
