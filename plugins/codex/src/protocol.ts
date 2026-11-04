/** Secret-free status for the TUI; the server alone talks to the Unix socket. */
export const CODEX_STATUS = {
  id: "opencode-gent.codex",
  methods: { status: { input: { type: "object", properties: { owner: { type: "string" } } }, output: { type: "object" } } },
  events: {},
} as const
