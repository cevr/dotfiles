// The credential ids the pool persisted before its login store was renamed:
// a store login was `gent:<label>` and is `store:<label>` now. The pool's
// state (holds, readings, steps, cache marks, reset claims, pushes, the limit
// tally) names logins by id, so what an older pool wrote is read as the same
// login. Delete this module once every host has run a pool that rewrote its
// state (opencode/migrate.ts at start, the limit file at its next write).
import { Predicate, type Schema } from "effect"

/** The prefix a store login's credential id had before the rename. */
export const LEGACY_PREFIX = "gent:"

// A legacy id where an id starts: at the start of the text, or after a
// separator the pool's keys use (`/`, `:`, `|`), plain or URI-encoded (`%3A`
// in a resets key). `agent:` never matches: the letter before is no separator.
const LEGACY = /(^|[/:|]|%3A)gent(:|%3A)/g

/** `text` with every legacy credential id in it renamed to the store's prefix. */
export const renameText = (text: string): string => text.replace(LEGACY, "$1store$2")

/**
 * `value` with every string and object key in it renamed: the same value
 * (by reference) when it names no legacy id, so a caller can tell.
 */
export const renameValue = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return renameText(value)
  if (Predicate.isNull(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) return value
  if (Array.isArray(value)) {
    const items = value.map(renameValue)
    if (items.every((item, index) => item === value[index])) return value
    return items
  }
  const entries = Object.entries(value)
  const renamed = entries.map(([key, item]): [string, Schema.Json] => [renameText(key), renameValue(item)])
  if (renamed.every(([key, item], index) => key === entries[index]?.[0] && item === entries[index]?.[1])) return value
  return Object.fromEntries(renamed)
}
