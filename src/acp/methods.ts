/**
 * 协议方法名常量。保持字面量类型，便于 SDK 的泛型重载推断参数和响应。
 */
export const M = {
  initialize: "initialize",
  authenticate: "authenticate",
  logout: "logout",

  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionDelete: "session/delete",
  sessionResume: "session/resume",
  sessionClose: "session/close",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",

  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",

  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",

  requestPermission: "session/request_permission",
  sessionUpdate: "session/update",

  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
} as const;
