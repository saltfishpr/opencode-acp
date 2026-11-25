import { Rpc } from "@opencode/plugin/rpc"

const stringArray = { type: "array", items: { type: "string" } } as const

/**
 * Settings and diagnostics for the desktop settings page.
 *
 * `read` never starts an agent: it resolves the configured commands, reports
 * the live process state and returns the context window learned so far.
 */
export const AcpSettings = Rpc.define({
  id: "acp",
  events: {},
  methods: {
    read: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          plugin: {
            type: "object",
            properties: {
              id: { type: "string" },
              logLevel: { type: "string" },
              contextLimit: { type: "number" },
            },
            required: ["id", "logLevel", "contextLimit"],
            additionalProperties: false,
          },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                command: { type: "string" },
                args: stringArray,
                enabled: { type: "boolean" },
                installed: { type: "boolean" },
                path: { type: "string" },
                version: { type: "string" },
                status: { enum: ["ready", "missing", "disabled", "deferred"] },
                note: { type: "string" },
                defaultModel: { type: "string" },
                models: stringArray,
                contextLimit: { type: "number" },
                running: { type: "boolean" },
                pid: { type: "number" },
                lastFailure: { type: "string" },
              },
              required: [
                "id",
                "name",
                "command",
                "args",
                "enabled",
                "installed",
                "path",
                "version",
                "status",
                "note",
                "defaultModel",
                "models",
                "contextLimit",
                "running",
                "pid",
                "lastFailure",
              ],
              additionalProperties: false,
            },
          },
          note: { type: "string" },
        },
        required: ["plugin", "agents", "note"],
        additionalProperties: false,
      },
    },
  },
})
