import { Option, Predicate } from "effect"

/** Seal a module-owned constant, including own data of callable schemas. Never follow prototype inheritance or getters. */
export const immutable = <A>(value: A): A => {
  const seen = new WeakSet<object>()
  const visit = <B>(part: B): void => {
    if (!Predicate.isObjectKeyword(part) || seen.has(part)) return
    seen.add(part)
    for (const key of Reflect.ownKeys(part)) {
      const descriptor = Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(part, key))
      if (Option.isSome(descriptor) && "value" in descriptor.value) visit(descriptor.value.value)
    }
    Object.freeze(part)
  }
  visit(value)
  return value
}
