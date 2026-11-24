import { Option, Schema } from "effect"

/** A fixture registry shared by separate module copies; a symbol cannot name a guarded global. */
export const globalSlot = <A>(key: symbol | string) => {
  const symbol = Schema.decodeUnknownSync(Schema.Symbol)(key)
  const slots: Partial<Record<symbol, A>> = globalThis
  return {
    get: () => Option.fromUndefinedOr(slots[symbol]),
    set: (value: A) => { slots[symbol] = value },
    clear: () => { delete slots[symbol] },
  }
}
