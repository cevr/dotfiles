// What the digest keeps of a text the owner typed: an answer goes to the asking session as he wrote it, but the log
// and the page keep it with each well-known secret shape replaced by REDACTED, so a token pasted into an answer is
// not written to the log file nor shown on a page another browser may read.
//
// Caught: a private key block (from its BEGIN line to its END line, or to the end when cut), a bearer token, a
// key with a known prefix (sk-, sk_live_/sk_test_, ghp_/gho_/ghu_/ghs_/ghr_, github_pat_, xox?-, AKIA, AIza,
// glpat-), a JWT, and any other run of 32 or more letters, digits, `_`, `-`, `+` or `=` that mixes letters and
// digits and reads as random (at least 4.2 bits a character).
//
// Not caught: a short secret (a password, a 6-digit code, a key under 32 characters with no known prefix), one in
// lowercase hex (at most 4 bits a character, as a commit hash is), one split by spaces or `/` into short runs, and
// any secret whose shape is not on the list. Redaction is a net under the log, not a reason to paste a token.

import { Option } from "effect"

/** What a secret is replaced with. */
export const REDACTED = "[redacted]"

/** The shapes with a known form, each matched as a whole. */
export const KNOWN: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** A long run that may be a key of no known form. */
export const RUN = /[A-Za-z0-9_+=-]{32,}/g

/** The run's Shannon entropy, in bits a character. */
const entropy = (run: string): number => {
  const counts = new Map<string, number>()
  for (const char of run) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((bits, count) => {
    const p = count / run.length
    return bits - p * Math.log2(p)
  }, 0)
}

/** A run reads as random: letters and digits mixed, and dense enough that no hex or word reaches it. The commitment record (`orchestrate/printable.ts`) tests windows of a longer run with it. */
export const isRandom = (run: string): boolean => /[A-Za-z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 4.2

/** `text` with each secret shape replaced by REDACTED; the same text when it holds none. */
export const redact = (text: string): string => {
  const known = KNOWN.reduce((kept, form) => kept.replace(form, REDACTED), text)
  return known.replace(RUN, (run) => Option.getOrElse(Option.as(Option.liftPredicate(run, isRandom), REDACTED), () => run))
}
