// A memo that keeps the value it last gave while a new reading says the
// same: what reads it does not run, and a view that draws it asks the
// renderer for no frame. For values read again and again where a new object
// rarely says anything new: a session of a family on a host update to a field
// it does not carry, a subagent row's segments on a clock tick, the dock's
// wake item on a poll.
import { Option } from "effect"
import { createMemo, type Accessor } from "solid-js"

/** `compute` in a memo that gives back its last value while `same` holds between it and the new one. */
export function keptMemo<T>(compute: () => T, same: (last: T, next: T) => boolean): Accessor<T> {
  const last = { value: Option.none<T>() }
  return createMemo(() => {
    const next = compute()
    if (Option.isSome(last.value) && same(last.value.value, next)) return last.value.value
    last.value = Option.some(next)
    return next
  })
}
