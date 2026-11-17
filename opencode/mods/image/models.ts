// The subscription's main models: the GPT Sol models OpenCode lists for the
// `openai` provider, newest first, down to the fallback. The Codex backend
// refuses a model the account cannot use, and the run then asks the next one
// (model.ts), so the list runs from the newest to one every account has.
import { Array as Arr, Order } from "effect"
import { FALLBACK_MODEL } from "./request.ts"

/** One model as OpenCode lists it, by the fields this rule reads. */
export interface Listed {
  readonly providerID: string
  /** The model id the provider is asked with; the listing's own id may name a variant of it. */
  readonly modelID: string
  readonly family: string
  readonly deprecated: boolean
  /** Epoch ms. */
  readonly released: number
}

const SOL = /^gpt-\d+(?:\.\d+)?-sol$/u

const byNewest = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (model: Listed) => model.released),
  Order.mapInput(Order.flip(Order.String), (model: Listed) => model.modelID),
)

/** The Sol models to ask, newest first, each once, ending with the fallback. */
export const solModels = (listed: ReadonlyArray<Listed>): ReadonlyArray<string> => {
  const sols = Arr.filter(listed, (model) => model.providerID === "openai" && model.family === "gpt-sol" && !model.deprecated && SOL.test(model.modelID))
  const ids = Arr.dedupe(Arr.map(Arr.sort(sols, byNewest), (model) => model.modelID))
  const newer = Arr.takeWhile(ids, (id) => id !== FALLBACK_MODEL)
  return [...newer, FALLBACK_MODEL]
}
