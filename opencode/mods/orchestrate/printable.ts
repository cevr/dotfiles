import { Array as Arr, Brand, Cause, Option, Predicate, Result, Schema } from "effect"
import { isRandom, KNOWN, REDACTED, RUN_MIN, TOKEN_RUN } from "@dotfiles/opencode-digest/redact"

/** A text safe to print: every secret shape in it replaced, whole, before any cut. Only `printable` makes one. */
export type Printable = string & Brand.Brand<"Printable">

const make = Brand.nominal<Printable>()

const WEIGHT = Arr.makeBy(RUN_MIN + 1, (count) => count * Math.log2(Math.max(1, count)))

/**
 * Find a key glued to low-entropy text. Slide the entropy sum one character at a time, then confirm likely
 * windows with `isRandom`; the small margin keeps rounding in the running sum from deciding the match.
 */
const holdsKey = (run: string): boolean => {
  if (run.length < RUN_MIN) return false
  if (isRandom(run)) return true
  if (run.length === RUN_MIN) return false
  const counts = new Map<string, number>()
  let sum = 0
  const add = (char: string, by: number) => {
    const before = Option.getOrElse(Option.fromUndefinedOr(counts.get(char)), () => 0)
    counts.set(char, before + by)
    sum += WEIGHT[before + by] - WEIGHT[before]
  }
  for (let at = 0; at < RUN_MIN; at++) add(run[at], 1)
  for (let at = 0; at <= run.length - RUN_MIN; at++) {
    if (Math.log2(RUN_MIN) - sum / RUN_MIN >= 4.19 && isRandom(run.slice(at, at + RUN_MIN))) return true
    if (at < run.length - RUN_MIN) {
      add(run[at], -1)
      add(run[at + RUN_MIN], 1)
    }
  }
  return false
}

type Span = { readonly start: number; readonly end: number }
const byStart = (a: Span, b: Span): number => a.start - b.start

// Match each form on the source, including starts inside a word or inside another match of the same kind.
const KNOWN_ANYWHERE = KNOWN.map((form) => new RegExp(form.source.replaceAll("\\b", ""), form.flags))
const knownSpans = (text: string): ReadonlyArray<Span> => {
  const spans: Array<Span> = []
  for (const form of KNOWN_ANYWHERE) {
    for (let next = Option.fromNullishOr(form.exec(text)); Option.isSome(next); next = Option.fromNullishOr(form.exec(text))) {
      const { value: match } = next
      spans.push({ start: match.index, end: match.index + match[0].length })
      form.lastIndex = match.index + 1
    }
  }
  return spans.sort(byStart)
}

/** `text` with the union of all recognized spans removed, widened by every maximal token run they touch. */
export const secretFree = (text: string): string => {
  const known = knownSpans(text)
  const spans = [...known]
  let at = 0
  for (const match of text.matchAll(TOKEN_RUN)) {
    const start = match.index
    const end = start + match[0].length
    while (at < known.length && known[at].end <= start) at++
    if (holdsKey(match[0]) || (at < known.length && known[at].start < end)) spans.push({ start, end })
  }
  if (spans.length === 0) return text
  spans.sort(byStart)
  // Walk the sorted union. No edit is made until the next disjoint span proves the previous one has ended.
  let output = ""
  let start = spans[0].start
  let end = start
  let copied = 0
  for (const span of spans) {
    if (span.start > end) {
      output += text.slice(copied, start) + REDACTED
      copied = end
      start = span.start
    }
    end = Math.max(end, span.end)
  }
  return output + text.slice(copied, start) + REDACTED + text.slice(end)
}

/** The shared store and output boundary. No recognizer reads a replacement or a truncated input. */
export const printable = (text: string): Printable => make(secretFree(text))

/** Combine text that has already crossed the boundary, without reinterpreting the rendered representation. */
export const printed = (parts: TemplateStringsArray, ...values: ReadonlyArray<Printable>): Printable =>
  make(parts.reduce((text, part, at) => text + part + Option.getOrElse(Arr.get(values, at), () => ""), ""))

export const joined = (parts: ReadonlyArray<Printable>, separator: Printable): Printable => make(parts.join(separator))

export const prefixOf = (text: Printable, length: number): Printable => make(text.slice(0, length))

export const trimmed = (text: Printable): Printable => make(text.trim())

const JsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Render declarative JSON only after rewriting its original strings, including object keys. */
export const printableJson = (value: Schema.Json): Printable => {
  const clean = (leaf: Schema.Json): Schema.Json => {
    if (Predicate.isString(leaf)) return printable(leaf)
    if (!Predicate.isObjectKeyword(leaf)) return leaf
    if (Arr.isArray<Schema.JsonArray | Schema.JsonObject>(leaf)) return leaf.map(clean)
    return Object.fromEntries(Object.entries(leaf).map(([key, field]) => [printable(key), clean(field)]))
  }
  return make(JsonLine(clean(value)))
}

const OPAQUE = printable("diagnostic unavailable (record/opaque-defect)")
const NO_DETAIL = printable("diagnostic unavailable (record/empty-defect)")

/**
 * Never invoke a defect's inspection or serialization hooks. Copy original own data leaves only; a getter,
 * symbol, uninspectable value, cycle or exhausted depth contributes a fixed diagnostic code instead of its text.
 */
export const diagnostic = (cause: unknown): Printable => {
  const seen = new WeakSet<object>()
  let budget = 128
  const walk = (cause: unknown, depth: number): Printable => {
    if (budget <= 0) return OPAQUE
    budget--
    if (Predicate.isString(cause)) return printable(cause)
    if (Predicate.isNumber(cause) || Predicate.isBoolean(cause)) return printable(String(cause))
    if (!Predicate.isObjectOrArray(cause) || depth === 0 || seen.has(cause)) return OPAQUE
    seen.add(cause)
    const names = Reflect.ownKeys(cause)
    const fields = names.slice(0, 32).flatMap((name) => {
      if (!Predicate.isString(name)) return [OPAQUE]
      if (name === "stack" || (name === "length" && Arr.isArray(cause))) return []
      const prop = Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(cause, name))
      if (Option.isNone(prop) || !Object.hasOwn(prop.value, "value")) return [OPAQUE]
      const value = walk(prop.value.value, depth - 1)
      if (name === "message") return [value]
      return [printed`${printable(name)}: ${value}`]
    })
    if (names.length > 32) fields.push(OPAQUE)
    if (fields.length === 0) return NO_DETAIL
    return joined(fields, printable("; "))
  }
  return Result.getOrElse(Result.try(() => walk(cause, 8)), () => OPAQUE)
}

/** Preserve an authored refusal; other causes surrender their original leaf values, never a pretty-printed cause. */
export const failureText = (cause: Cause.Cause<Printable>): Printable =>
  Option.getOrElse(Cause.findErrorOption(cause), () => {
    const defects = cause.reasons.flatMap((reason) => {
      if (reason._tag === "Die") return [diagnostic(reason.defect)]
      return []
    })
    return printed`record: ${joined(Arr.match(defects, { onEmpty: () => [NO_DETAIL], onNonEmpty: (each) => each }), printable("; "))}`
  })

// The modeled errors still have schemas, but no caller can decode an unchecked Printable. Decoding any of
// these enclosing error schemas checks its text; ordinary callers construct them with an already-safe value.
const PrintableField = Schema.declare<Printable>((value): value is Printable => Predicate.isString(value) && secretFree(value) === value)

export class RecordRefused extends Schema.TaggedError<RecordRefused>()("RecordRefused", { reason: PrintableField }) {}
export class RecordFailed extends Schema.TaggedError<RecordFailed>()("RecordFailed", { message: PrintableField }) {}
export class EvidenceRefused extends Schema.TaggedError<EvidenceRefused>()("EvidenceRefused", { reason: PrintableField }) {}
