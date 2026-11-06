// What a failed webfetch call means, and the words the agent reads instead.
//
// OpenCode's built-in webfetch fails on three things an agent hits weekly
// (measured over 7 days on both hosts: 14 failures): a PDF ("Unsupported
// fetched file content type: application/pdf"), a body over its 5 MB limit
// ("Response too large (exceeds 5242880 byte limit)"), and a 404 on a URL the
// agent guessed (a raw.githubusercontent path, a docs page). `classify` reads
// the built-in's failure message; the model (`model.ts`) reads a PDF as text,
// cuts an oversized body, and turns a 404 into what to do instead. Every
// other failure stays the host's.
import { Schema } from "effect"

/** The fetch fails, and `message` is what the agent reads: what went wrong and what to do instead. */
export class Unfetchable extends Schema.TaggedError<Unfetchable>()("Unfetchable", {
  url: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

/** A failed fetch, as far as the web mod acts on it. */
export type Failure =
  | { readonly _tag: "Missing"; readonly status: number }
  | { readonly _tag: "Pdf" }
  | { readonly _tag: "TooLarge" }
  | { readonly _tag: "Other" }

const MISSING = /non 2xx status code \((404|410) /
const CONTENT_TYPE = /Unsupported fetched file content type: ([^\s;]+)/
const TOO_LARGE = /Response too large/

/** Whether a fetched file is a PDF: its content type says so, or a generic binary type comes from a `.pdf` path. */
export const isPdf = (mime: string, url: string): boolean => {
  const type = mime.toLowerCase()
  if (type === "application/pdf" || type === "application/x-pdf") return true
  if (type !== "application/octet-stream" && type !== "binary/octet-stream") return false
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf")
  } catch {
    return false
  }
}

/** The failure the built-in's message names, for the URL it fetched. */
export const classify = (message: string, url: string): Failure => {
  const missing = MISSING.exec(message)
  if (missing) return { _tag: "Missing", status: Number(missing[1]) }
  const type = CONTENT_TYPE.exec(message)
  if (type && isPdf(type[1] ?? "", url)) return { _tag: "Pdf" }
  if (TOO_LARGE.test(message)) return { _tag: "TooLarge" }
  return { _tag: "Other" }
}

/** The GitHub repository (`owner/repo`) a raw-file or blob URL points into, if it is one. */
export const repoOf = (url: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const [owner, repo, kind] = parsed.pathname.split("/").filter((part) => part !== "")
  if (owner === undefined || repo === undefined) return undefined
  const host = parsed.hostname.toLowerCase()
  if (host === "raw.githubusercontent.com") return `${owner}/${repo}`
  if (host === "github.com" && (kind === "blob" || kind === "tree" || kind === "raw")) return `${owner}/${repo.replace(/\.git$/, "")}`
  return undefined
}

/** What the agent reads for a 404 (or 410): the page is not there, and what to do instead of guessing again. */
export const missingMessage = (url: string, status: number): string => {
  const repo = repoOf(url)
  if (repo !== undefined)
    return `${url} answered ${status}: no file at that path (a guessed path or branch). Stop guessing raw URLs: run \`okra repo fetch ${repo}\` (it prints the local checkout's path), then read or grep the files there.`
  return `${url} answered ${status}: no page at that URL (a guessed docs path). Find the real page with websearch, or read the project's source and docs locally with \`okra repo fetch <owner/repo>\`.`
}

const KB = 1024
const MB = 1024 * 1024

/** A byte count in the unit a person reads: `512 KB`, `6.2 MB`. */
export const size = (bytes: number): string => {
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(1))} MB`
  return `${Math.max(1, Math.round(bytes / KB))} KB`
}

/** The first line of a cut answer: how much is shown, of how much, and how to read the rest. */
export const cutNote = (input: { readonly url: string; readonly shownBytes: number; readonly totalBytes?: number; readonly what: string }): string => {
  const total = input.totalBytes === undefined ? "a larger body" : `${size(input.totalBytes)}`
  return `[webfetch: ${input.what} cut to the first ${size(input.shownBytes)} of ${total}. For the rest, download it (\`curl -sL '${input.url}' -o <file>\`) and read the file in parts.]`
}

/** `text` cut to at most `maxBytes` of UTF-8, at a character boundary; `cut` says whether anything was dropped. */
export const cutText = (text: string, maxBytes: number): { readonly text: string; readonly cut: boolean; readonly bytes: number } => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return { text, cut: false, bytes: bytes.byteLength }
  // Back off to the start of a character: a UTF-8 continuation byte is 10xxxxxx.
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), cut: true, bytes: bytes.byteLength }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

/**
 * The readable text of an HTML fragment: scripts, styles and tags dropped,
 * block ends as line breaks, the common entities decoded. For a body cut
 * mid-document, where a full HTML-to-Markdown conversion has no document to
 * work on.
 */
export const textOf = (html: string): string =>
  html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?(<\/\1>|$)/gi, "")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>?/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
