import { Option, Schema } from "effect"
import { productBudgetParts } from "../tests/hang-guard.ts"

type Approval = { readonly file: string; readonly target: string; readonly budget: string }
const tupleKey = Schema.encodeSync(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])))
export const measurementKey = ({ file, target, budget }: Approval) => tupleKey([file, target, budget])

interface Bound {
  readonly family: string
  readonly limit: number
  readonly inclusive: number
}

const tightness = (budget: string) => Option.map(Option.filter(productBudgetParts(budget), (parts) => Number.isFinite(parts.limit)), ({ operator, unit, limit }): Bound => {
  const inclusive = Number(operator.endsWith("="))
  if (operator.startsWith("<")) return { family: `< ${unit}`, limit, inclusive }
  return { family: `> ${unit}`, limit: -limit, inclusive }
})

const compare = (a: Bound, b: Bound) => a.limit - b.limit || a.inclusive - b.inclusive

/** Match each approval to one same-target, same-unit base slot it does not loosen. */
export const unapprovedMeasurements = <A extends Approval>(base: ReadonlyArray<Approval>, candidate: ReadonlyArray<A>): ReadonlyArray<A> => {
  const family = ({ file, target }: Approval, kind: string) => tupleKey([file, target, kind])
  const slots = new Map<string, Array<Bound>>()
  for (const approval of base) {
    const bound = tightness(approval.budget)
    if (Option.isNone(bound)) continue
    const k = family(approval, bound.value.family)
    const found = Option.getOrElse(Option.fromUndefinedOr(slots.get(k)), (): Array<Bound> => [])
    found.push(bound.value)
    slots.set(k, found)
  }
  for (const bounds of slots.values()) bounds.sort(compare)
  const rejected: Array<A> = []
  for (const approval of candidate) {
    const bound = tightness(approval.budget)
    const matched = Option.exists(bound, (limit) => Option.exists(Option.fromUndefinedOr(slots.get(family(approval, limit.family))), (pool) => {
      const index = pool.findIndex((item) => compare(limit, item) <= 0)
      if (index < 0) return false
      pool.splice(index, 1)
      return true
    }))
    if (!matched) rejected.push(approval)
  }
  return rejected
}
