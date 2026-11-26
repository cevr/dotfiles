import { SIM_MODEL, type CatalogModel } from "../../sim/world.ts"

/** An Opus catalog record backed by the scripted model, not a network provider. */
export const SIM_OPUS: CatalogModel = {
  ...SIM_MODEL,
  providerID: "anthropic",
  id: "claude-opus-sim",
  modelID: "claude-opus-sim",
  family: "claude-opus",
  variants: [{ id: "medium" }],
}
