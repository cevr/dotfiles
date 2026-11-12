/**
 * The update's RPC, in the resident location: `check` looks for the verified target now and
 * installs it, the run going on after the answer (`bun run daily --update` asks it); `placement`
 * answers where the service runs (`placement.ts`), which the handoff's health check reads. The
 * definition is the wire contract, kept byte for byte.
 */
export const UPDATE = {
  id: "dotfiles-opencode.update",
  methods: {
    check: { input: { type: "object" }, output: { type: "object" } },
    placement: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const
