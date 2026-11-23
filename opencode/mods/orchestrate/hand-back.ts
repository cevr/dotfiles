// The one way a hand-back is admitted for judgment (batch 23e B1). A hand-back arrives as JSON and is decoded once
// by the Schema of its exact shape: exact member types, no excess member, arrays of the exact obstacle words with no
// duplicate, no member optional. A decode failure is the fault, named by its path. Only the decoded, typed value is
// compared with the due one, field by field by each field's Schema equivalence: never through String(), a template,
// join, JSON.stringify, a sort of mixed values, == or truthiness. The rendering of a fault is text for a reader and is
// never compared.
//
// The states and obstacle rows are the end-of-step model's (skills/orchestrate/scripts/ending.ts, which this domain
// fence keeps out of reach; ending.test.ts pins them equal). The round-policy compiler lifts this file as is.
import { Option, Predicate, Result, Schema, SchemaIssue } from "effect"
import type { StandardSchemaV1 } from "effect/StandardSchema"

/** Every state an item can take in an end-of-step list. */
export const HAND_BACK_STATES = [
  "done",
  "proven",
  "runnable",
  "waits",
  "refused",
  "cannot",
  "unclear",
  "unproven",
  "discovery",
  "unitFinding",
  "baseFinding",
] as const
/** The obstacle rows a hand-back gives the evidence of, or names after the label. */
export const HAND_BACK_OBSTACLES = ["refused", "cannot", "waits"] as const

export const ObstacleRow = Schema.Literals(HAND_BACK_OBSTACLES)
const Others = Schema.UniqueArray(ObstacleRow)

/** A hand-back, exactly: every member required, each of its exact type. */
export const HandBack = Schema.Struct({
  state: Schema.Literals(HAND_BACK_STATES),
  label: Schema.NonEmptyString,
  evidence: Schema.NullOr(ObstacleRow),
  others: Others,
  lastAttempt: Schema.Boolean,
})
export type HandBack = typeof HandBack.Type

const decode = Schema.decodeUnknownResult(HandBack, { onExcessProperty: "error", errors: "all" })
const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

const same = {
  state: Schema.toEquivalence(HandBack.fields.state),
  label: Schema.toEquivalence(HandBack.fields.label),
  evidence: Schema.toEquivalence(HandBack.fields.evidence),
  others: Schema.toEquivalence(Others),
  lastAttempt: Schema.toEquivalence(HandBack.fields.lastAttempt),
}

/** Where a label's first code span ends, when it has one. */
const codeSpanEnd = (label: string): Option.Option<number> => {
  const open = label.indexOf("`")
  if (open < 0) return Option.none()
  const close = label.indexOf("`", open + 1)
  if (close < 0) return Option.none()
  return Option.some(close)
}

/** A label's words before its first ", ", or all of it. */
const beforeComma = (label: string): string => {
  const comma = label.indexOf(", ")
  if (comma < 0) return label
  return label.slice(0, comma)
}

/**
 * A label's word: the literal a hand-back writes for it, without the words that say where it goes. It is the label
 * through the end of its first code span (`refused: <what>`, marked `base`); with no code span, its words before the
 * first ", " (a Blocker or Major); else all of it (none: it is no item left). None when that would be blank.
 */
export const labelWord = (label: string): Option.Option<string> =>
  Option.some(Option.match(codeSpanEnd(label), { onSome: (end) => label.slice(0, end + 1), onNone: () => beforeComma(label) })).pipe(
    Option.filter((word) => word.trim() !== ""),
  )

/** Obstacle rows in the model's order: a hand-back's `others` is a set, so its order is not its content. */
const canonical = (rows: ReadonlyArray<(typeof HAND_BACK_OBSTACLES)[number]>) => HAND_BACK_OBSTACLES.filter((row) => rows.includes(row))

/** One segment of a decode path as a reader writes it: `[0]`, `.key`, or the member itself first. */
const keyText = (key: PropertyKey, index: number): string => {
  if (Predicate.isNumber(key)) return `[${key}]`
  if (Predicate.isSymbol(key)) return `[${key.description ?? "symbol"}]`
  if (index === 0) return key
  return `.${key}`
}

const keyOf = (segment: PropertyKey | StandardSchemaV1.PathSegment): PropertyKey => {
  if (Predicate.isPropertyKey(segment)) return segment
  return segment.key
}

/** One decode failure as text: its path, then what was expected there. */
const issueText = (path: ReadonlyArray<PropertyKey>, message: string): string => {
  if (path.length === 0) return message
  return `${path.map(keyText).join("")}: ${message}`
}

/** Each member as a fault names it: the reader's words, the same for a decode failure and a wrong value. */
export const fieldName = (member: string): string => {
  if (member === "lastAttempt") return "last attempt"
  return member
}

/** The field a decode failure is in, as a fault names it, or `hand-back` when it is the whole. */
const memberOf = (path: ReadonlyArray<PropertyKey>): string => {
  const [head] = path
  if (Predicate.isString(head)) return fieldName(head)
  return "hand-back"
}

/** Each decode failure, one per top-level member (or `hand-back` for the whole), with every path inside it. */
const decodeFaults = (issue: SchemaIssue.Issue): string[] => {
  const byMember = new Map<string, ReadonlyArray<string>>()
  for (const one of formatter(issue).issues) {
    const path = (one.path ?? []).map(keyOf)
    const member = memberOf(path)
    byMember.set(member, [...(byMember.get(member) ?? []), issueText(path, one.message)])
  }
  return [...byMember].map(([member, messages]) => `${member}: ${messages.join("; ")}`)
}

const rows = (list: ReadonlyArray<string>) => `[${list.join(", ")}]`

const presence = (on: boolean): string => {
  if (on) return "present"
  return "absent"
}

/** Every field of the decoded hand-back that differs from the due one, each named with both values. */
const fieldFaults = (due: HandBack, got: HandBack): string[] => {
  const word = labelWord(due.label)
  const labelMatches = same.label(got.label, due.label) || Option.exists(word, (one) => same.label(got.label, one))
  const out: string[] = []
  if (!same.state(got.state, due.state)) out.push(`state: due ${due.state}, given ${got.state}`)
  if (!labelMatches) out.push(`label: due ${Option.getOrElse(word, () => due.label)}, given ${got.label}`)
  if (!same.evidence(got.evidence, due.evidence)) out.push(`evidence: due ${due.evidence ?? "none"}, given ${got.evidence ?? "none"}`)
  if (!same.others(canonical(got.others), canonical(due.others))) out.push(`others: due ${rows(due.others)}, given ${rows(got.others)}`)
  if (!same.lastAttempt(got.lastAttempt, due.lastAttempt)) out.push(`last attempt: due ${presence(due.lastAttempt)}, given ${presence(got.lastAttempt)}`)
  return out
}

/**
 * The faults of a hand-back, as it arrived (JSON), against the one due: the decode's, by path, when it is not a
 * hand-back of the exact shape; else each field the decoded value gives otherwise than the due one. Empty when it is
 * the due hand-back.
 */
export const judgeHandBack = (due: HandBack, given: Schema.Json): string[] =>
  Result.match(decode(given), { onFailure: (error) => decodeFaults(error.issue), onSuccess: (got) => fieldFaults(due, got) })
