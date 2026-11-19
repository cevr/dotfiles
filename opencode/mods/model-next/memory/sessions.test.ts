import { laws } from "../laws.ts"
import { layer, store } from "./sessions.ts"

laws("memory", () => {
  const held = store()
  held.records.set("ses_a", { model: { providerID: "sim", id: "old" }, metadata: { latch: "kept" } })
  return { layer: layer(held) }
})
