/** The pool's own RPC: each pooled provider's accounts, holds and readings. No secrets. */
export const POOL_STATUS = {
  id: "opencode-gent.pool",
  methods: {
    status: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const

