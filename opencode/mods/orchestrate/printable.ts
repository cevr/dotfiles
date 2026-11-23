// The one way a text leaves the commitment record: its store, its tools and its CLI. A refusal, an error, a tool's
// answer, a log line and the CLI's output each take `Printable`, which only `printable` makes, so a text that skipped
// it does not compile. `printable` replaces every secret shape in the WHOLE text, and nothing before it cuts a text
// (mods/orchestrate/printable.test.ts holds the record's modules to that), so no cut can leave a fragment of a token
// too short to be known as one.
import { Array as Arr, Brand, Match, Option, Schema } from "effect"
import { isRandom, KNOWN, REDACTED, RUN } from "@dotfiles/opencode-digest/redact"

/** A text safe to print: every secret shape in it replaced, whole, before any cut. Only `printable` makes one. */
export const Printable = Schema.String.pipe(Schema.brand("Printable"))
export type Printable = typeof Printable.Type

const make = Brand.nominal<Printable>()

/** The width of a window a key of no known form fills: the redactor's shortest random run. */
const WINDOW = 32

/** `c log2 c`: a character's share of a window's entropy sum. */
const weight = (count: number): number => Math.max(0, count * Math.log2(Math.max(1, count)))

/**
 * Each window of WINDOW characters of `run`, as the entropy the redactor's `isRandom` reads (bits a character), slid
 * one character at a time: `log2(n) - Σ c log2 c / n`, the sum kept as characters enter and leave.
 */
const windowEntropies = (run: string): ReadonlyArray<number> => {
  const counts = new Map<string, number>()
  const add = (char: string, by: number, sum: number) => {
    const before = Option.getOrElse(Option.fromUndefinedOr(counts.get(char)), () => 0)
    counts.set(char, before + by)
    return sum - weight(before) + weight(before + by)
  }
  const first = Arr.reduce(Arr.range(0, WINDOW - 1), 0, (sum, at) => add(run[at], 1, sum))
  return Arr.scan(Arr.range(WINDOW, Math.max(WINDOW, run.length - 1)), first, (sum, at) => add(run[at - WINDOW], -1, add(run[at], 1, sum))).map(
    (sum) => Math.log2(WINDOW) - sum / WINDOW,
  )
}

/**
 * Some window of `run` reads as random: a key glued to other text, which the redactor reads as one run that is not.
 * Its windows are read by entropy, slid, and the dense ones by `isRandom` itself, so the rule stays the redactor's.
 */
const holdsKey = (run: string): boolean =>
  Arr.some(windowEntropies(run), (bits, at) => bits >= 4.2 && at + WINDOW <= run.length && isRandom(run.slice(at, at + WINDOW)))

/**
 * The digest's known forms as one pattern, each wherever it starts: glued to a word (`xghp_…`) too, where its word
 * boundary does not hold. One pass over a text, the private key block first, as the redactor tries them.
 */
const KNOWN_ANYWHERE = new RegExp(KNOWN.map((form) => `(?:${form.source.replaceAll("\\b", "")})`).join("|"), "g")

/**
 * `text` with every secret shape replaced: each of the digest's known forms (glued to a word too), then each run the
 * redactor reads as random, or that holds a random window (a key glued to a word, as `aaaa…Q7mZ2xL9…`), replaced whole. The record's one rule for a secret: a value it changes holds one (record.ts `holdsSecret`), and
 * every output passes it.
 */
export const secretFree = (text: string): string =>
  text.replace(KNOWN_ANYWHERE, REDACTED).replace(RUN, (run) =>
    Match.value(isRandom(run) || holdsKey(run)).pipe(
      Match.when(true, () => REDACTED),
      Match.orElse(() => run),
    ),
  )

/**
 * `text` as it may be printed: every secret shape replaced on the whole text. The only maker of `Printable`, and it
 * cuts nothing: a refusal names a field, never its value, so no output needs a value cut to fit.
 */
export const printable = (text: string): Printable => make(secretFree(text))
