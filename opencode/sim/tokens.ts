// Every secret shape the record refuses to repeat, at every place in a value: the acceptance of its one output rule
// (mods/orchestrate/printable.ts). A shape is the digest's redactor's (mods/digest/redact.ts): a key with a known
// prefix, a JWT, a bearer token, a private key block, or a run of 32 or more letters, digits, `_`, `-`, `+` or `=` that
// reads as random. A placement puts one in a value: alone, after text of any length (so across every cut a refusal
// ever made, 60 and 80 among them), glued to a word, at the end, twice, inside JSON, quoted, and encoded where the rule
// still reads it (base64url of 32 characters or more, and URL-encoding of a kind it leaves one run).
//
// The leak a test looks for: any substring of at least LEAK_MIN characters of a token's secret part (its random body;
// the public prefix, `ghp_` or `Bearer `, names only the shape). Six because a fragment of six random characters is
// one of 62^6 (about 5.7e10), so it never turns up in the record's own words by chance, and because the fragment r5
// found printed was 26 characters: any fragment worth a guess is longer. Not in the rule, so not placed: lowercase or
// uppercase hex (at most 4 bits a character), standard base64 whose `/` splits it into runs under 32, a private key
// block URL-encoded, and a key under 32 characters with no known prefix (redact.ts's "Not caught").
import { Array as Arr, type Random } from "effect"
import { Base64Url } from "effect/encoding"
import { below } from "./runtime.ts"

/** A secret as a value carries it: the text placed, and each secret part a printed fragment of would leak. */
export interface Placed {
  readonly value: string
  readonly secrets: ReadonlyArray<string>
}

/** One token: its whole text, and its secret part. */
export interface Token {
  readonly kind: string
  readonly text: string
  readonly secret: string
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const BASE64 = `${ALNUM}+/`

/** `n` characters of `alphabet`, drawn from `random`, with at least one letter and one digit when the alphabet has both. */
const drawn = (random: Random.Random, alphabet: string, n: number): string => {
  const body = Arr.makeBy(n, () => alphabet[below(random, alphabet.length)]).join("")
  return `${body.slice(0, n - 2)}Q7`
}

/** A token of a shape the rule refuses, from its prefix and its body. */
const token = (kind: string, prefix: string, secret: string, suffix = ""): Token => ({ kind, text: `${prefix}${secret}${suffix}`, secret })

/** Every shape the rule refuses, each drawn from `random`. */
export const KINDS: ReadonlyArray<readonly [string, (random: Random.Random) => Token]> = [
  ["random key", (random) => token("random key", "", drawn(random, ALNUM, 40))],
  ["ghp_", (random) => token("ghp_", "ghp_", drawn(random, ALNUM, 36))],
  ["github_pat_", (random) => token("github_pat_", "github_pat_", drawn(random, `${ALNUM}_`, 82))],
  ["sk-", (random) => token("sk-", "sk-", drawn(random, ALNUM, 48))],
  ["sk_live_", (random) => token("sk_live_", "sk_live_", drawn(random, ALNUM, 24))],
  ["xoxb-", (random) => token("xoxb-", "xoxb-", drawn(random, ALNUM, 40))],
  ["AKIA", (random) => token("AKIA", "AKIA", drawn(random, UPPER, 16))],
  ["AIza", (random) => token("AIza", "AIza", drawn(random, ALNUM, 35))],
  ["glpat-", (random) => token("glpat-", "glpat-", drawn(random, ALNUM, 20))],
  ["jwt", (random) => token("jwt", "eyJ", `${drawn(random, ALNUM, 33)}.${drawn(random, ALNUM, 40)}.${drawn(random, ALNUM, 43)}`)],
  ["bearer", (random) => token("bearer", "Bearer ", drawn(random, ALNUM, 40))],
  ["private key", (random) => token("private key", "-----BEGIN PRIVATE KEY-----\n", `${drawn(random, BASE64, 64)}\n${drawn(random, BASE64, 64)}`, "\n-----END PRIVATE KEY-----")],
]

/** A word of `n` letters: text before a token, low in entropy, as a caller's own words are. */
const words = (n: number): string => "abcdefgh ".repeat(Math.ceil(n / 9)).slice(0, n)
const letters = (n: number): string => "a".repeat(n)

/** The lengths of text before a token: every cut a refusal made (60, 80) and the run's 32, each side of it. */
export const OFFSETS: ReadonlyArray<number> = [0, 1, 5, 26, 27, 31, 32, 33, 53, 54, 59, 60, 61, 79, 80, 81, 100, 119, 120]

/** The redactor's shortest run: an encoding shorter than it (a 20-character AKIA key's base64url) is outside the rule. */
const RUN_MIN = 32

/** A shape the URL-encoding leaves one run (the rule still reads it): not a private key block, whose lines it splits. */
const urlReads = (each: Token): boolean => each.kind !== "private key"

/** Every placement of `each`: its name and the value. */
export const placements = (each: Token): ReadonlyArray<readonly [string, Placed]> => {
  const one = (value: string): Placed => ({ value, secrets: [each.secret] })
  return [
    ["alone", one(each.text)],
    ...OFFSETS.map((n): readonly [string, Placed] => [`after ${n} letters and a space`, one(`${letters(n)} ${each.text}`)]),
    ...OFFSETS.map((n): readonly [string, Placed] => [`after ${n} characters of words`, one(`${words(n)}${each.text}`)]),
    ...OFFSETS.map((n): readonly [string, Placed] => [`glued after ${n} letters`, one(`${letters(n)}${each.text}`)]),
    ["at the start", one(`${each.text} is what it said`)],
    ["at the end, glued", one(`the key was${each.text}`)],
    ["twice", one(`${each.text} and again ${each.text}`)],
    ["inside JSON", one(`{"token":"${each.text}","n":1}`)],
    ["quoted", one(`"${each.text}"`)],
    ...Arr.filter([Base64Url.encode(each.text)], (encoded) => encoded.length >= RUN_MIN).map((encoded): readonly [string, Placed] => ["base64url", { value: encoded, secrets: [each.secret, encoded] }]),
    ...Arr.filter([each], urlReads).map((reads): readonly [string, Placed] => ["URL-encoded", one(encodeURIComponent(reads.text))]),
  ]
}

/** The shortest fragment of a secret that counts as a leak. */
export const LEAK_MIN = 6

/** Every fragment of `secret` of LEAK_MIN characters (any longer one holds one). */
const fragmentsOf = (secret: string): ReadonlyArray<string> => Arr.makeBy(Math.max(0, secret.length - LEAK_MIN + 1), (at) => secret.slice(at, at + LEAK_MIN))

/** The fragments of `placed`'s secrets that `text` holds: none, when nothing leaked. */
export const leaked = (text: string, placed: Placed): ReadonlyArray<string> => Arr.filter(placed.secrets.flatMap(fragmentsOf), (fragment) => text.includes(fragment))

/** Every LEAK_MIN-character window of `text`: a large text (a record's bytes) searched once for many secrets. */
export const windowsOf = (text: string): ReadonlySet<string> => new Set(fragmentsOf(text))

/** The fragments of `placed`'s secrets among `windows`. */
export const leakedFrom = (windows: ReadonlySet<string>, placed: Placed): ReadonlyArray<string> => Arr.filter(placed.secrets.flatMap(fragmentsOf), (fragment) => windows.has(fragment))

/** The `at`-th placement of a token, cycling shapes and placements so a run covers each, a seed's draw moving both. */
export const placedAt = (random: Random.Random, at: number): readonly [string, Placed] => {
  const [kind, draw] = KINDS[(at + below(random, KINDS.length)) % KINDS.length]
  const all = placements(draw(random))
  const [where, placed] = all[(at * 7 + below(random, all.length)) % all.length]
  return [`${kind} ${where}`, placed]
}
