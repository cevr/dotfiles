/** The pool's own RPC: each pooled provider's accounts, holds and readings. No secrets. */
export const POOL_STATUS = {
  id: "opencode-gent.pool",
  methods: {
    pace: { input: { type: "object", properties: { providerID: { type: "string" } }, required: ["providerID"] }, output: { type: "object" } },
    status: { input: { type: "object" }, output: { type: "object" } },
  },
  events: {},
} as const

