import { Predicate } from "effect"
import { visitorKeys } from "oxc-parser"

export const node = <T>(value: T) => {
  if (!Predicate.isObject(value) || !("type" in value) || !("start" in value)) return
  if (!Predicate.isString(value.type) || !Predicate.isNumber(value.start)) return
  return { type: value.type, start: value.start, fields: new Map(Object.entries(value)) }
}

export type MaybeNode = ReturnType<typeof node>
export type Node = NonNullable<MaybeNode>
export const field = (at: MaybeNode, key: string) => at?.fields.get(key)
export const child = (at: MaybeNode, key: string) => node(field(at, key))
export const one = <T>(value?: T): ReadonlyArray<T> => {
  if (Predicate.isUndefined(value)) return []
  return [value]
}
export const nodes = <T>(value: T): ReadonlyArray<Node> => (Array.isArray(value) && value.flatMap((each) => one(node(each)))) || []
export const str = <T>(value: T) => {
  if (Predicate.isString(value)) return value
}
export type MaybeString = ReturnType<typeof str>
export const id = (at: MaybeNode) => {
  if (at?.type === "Identifier") return str(field(at, "name"))
}
export const literal = (at: MaybeNode) => {
  if (at?.type === "Literal") return str(field(at, "value"))
}
export const property = (at: MaybeNode) => {
  if (at?.type !== "MemberExpression") return
  if (field(at, "computed")) return literal(child(at, "property"))
  return id(child(at, "property"))
}
export const unwrap = (at: MaybeNode): MaybeNode => {
  if (at && ["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "ChainExpression", "AwaitExpression", "YieldExpression"].includes(at.type))
    return unwrap(child(at, "expression") ?? child(at, "argument"))
  return at
}
export const children = (at: Node): ReadonlyArray<Node> => (visitorKeys[at.type] ?? []).flatMap((key) => {
  const value = field(at, key)
  const single = node(value)
  if (single) return [single]
  return nodes(value)
})
