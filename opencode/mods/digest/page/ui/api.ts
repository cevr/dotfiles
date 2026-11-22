// The page's one connection to its server: the view, whether this browser is paired, and the writes. Every write is
// a JSON POST with the page's header, from the page's own origin (the listener refuses anything else), or, for a
// peer's item, to that peer's page, tokenless (send: the peer allows this page's origin and judges by source). An answer
// needs this browser paired; on the tailnet so does every mark, and every read, unless the browser is on one of his
// own devices and digest.tailnetRead or digest.tailnetWrite is "member" (or "member-except-hosts", where an agent
// machine still pairs).
// Paired means the token `/api/pair` answered, kept in this origin's localStorage (scheme, host and port: no other
// server on 127.0.0.1 reads it, as it would a cookie) and sent as TOKEN_HEADER. It never goes in a URL.
import type { View } from "./types.ts"

const PAGE_HEADER = "x-digest-page"
const TOKEN_HEADER = "x-digest-token"
const TOKEN_KEY = "digest.token"

/** This browser's token, if paired (storage refused, as in a private window: none). */
const token = (): string => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

/** The token kept, or forgotten (an empty one). */
export const keepToken = (value: string) => {
  try {
    if (value === "") localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, value)
  } catch {
    // Storage refused: this browser cannot stay paired, and the page says so when an answer is refused.
  }
}

/** The token header, when this browser has one. */
const paired = (): Record<string, string> => (token() === "" ? {} : { [TOKEN_HEADER]: token() })

/** The view is not this browser's to read until it pairs (the page on the tailnet). */
export class Unpaired extends Error {}

/** The view now; a failure says why (the server restarting, a marks file of a newer build, or Unpaired). */
export const fetchView = async (): Promise<View> => {
  const answer = await fetch("./view.json", { cache: "no-store", headers: paired() })
  if (answer.status === 401) throw new Unpaired("pair this browser to read the digest")
  if (!answer.ok) {
    const said = await answer.json().catch(() => ({ reason: `the server answered ${answer.status}` }))
    throw new Error(said.reason ?? `the server answered ${answer.status}`)
  }
  return answer.json()
}

/**
 * A write: to this page's own server (`at` none), with this browser's token; or to a peer's page (`at`, its origin,
 * the host that owns the item) with no token and no credential at all. This origin holds no token of a peer's and
 * never will: pairing with a peer is done on the peer's own page, and its token stays in that origin.
 */
const send = (path: string, body: Record<string, string>, at?: string): Promise<Response> =>
  at === undefined
    ? fetch(`.${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", [PAGE_HEADER]: "1", ...paired() } })
    : fetch(`${at}${path}`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", [PAGE_HEADER]: "1" },
      }).catch(() => {
        throw new PeerRefused("unreachable")
      })

/** A mark is not this browser's to write until it pairs (the page on the tailnet, read open to every member). */
export class MarkUnpaired extends Error {}

/**
 * A peer would not take a write from this page: it needs this browser paired on its own page (`pair`), or this page
 * cannot write there at all (`unreachable`: the peer is down, or does not let this page's origin write to it).
 */
export class PeerRefused extends Error {
  constructor(readonly why: "pair" | "unreachable") {
    super(why === "pair" ? "that host needs this browser paired on its own page" : "this page cannot write to that host")
  }
}

const post = async (path: string, body: Record<string, string>, at?: string): Promise<void> => {
  const answer = await send(path, body, at)
  if (answer.status === 401 && at !== undefined) throw new PeerRefused("pair")
  if (answer.status === 401) throw new MarkUnpaired("pair this browser to mark messages here")
  if (!answer.ok) throw new Error(`the server refused it (${answer.status})`)
}

export const markRead = (id: string, read: boolean, at?: string) => post("/api/mark", { id, mark: read ? "read" : "unread" }, at)
export const setLater = (id: string, at?: string) => post("/api/later", { id }, at)
export const rename = (project: string, name: string, at?: string) => post("/api/name", { project, name }, at)
export const firstVisit = () => post("/api/since", {})

/**
 * Whether this browser may answer here: its token is one the digest knows, or it is one of his own devices on the
 * tailnet (digest.tailnetWrite), which needs no pairing. The server says, for this browser alone.
 */
export const fetchAnswers = async (): Promise<boolean> => {
  const answer = await fetch("./paired.json", { cache: "no-store", headers: paired() })
  if (!answer.ok) return false
  const said: { readonly answers?: boolean } = await answer.json()
  return said.answers === true
}

/** A pairing code exchanged for this browser's token, kept; a refusal says why (used, out of time, too many tries). */
export const pair = async (code: string): Promise<void> => {
  const answer = await send("/api/pair", { code })
  if (answer.ok) {
    const said: { readonly token?: string } = await answer.json()
    keepToken(said.token ?? "")
    if (token() === "") throw new Error("this browser keeps no site storage (a private window?), so it cannot stay paired")
    return
  }
  const said: { readonly reason?: string } = await answer.json().catch(() => ({}))
  throw new Error(said.reason ?? `the server refused it (${answer.status})`)
}

/** What became of an answer: sent; closed already (that answer, where, when); or refused, and why. */
export type Outcome =
  | { readonly tag: "sent" }
  | { readonly tag: "closed"; readonly answer?: string; readonly via?: string; readonly at?: number }
  | { readonly tag: "refused"; readonly status: number; readonly reason: string }

/** His answer to the message `id`: one of its options, or his own words; `at`, a peer's page that owns it (send). */
export const answer = async (id: string, given: { readonly option: string } | { readonly text: string }, at?: string): Promise<Outcome> => {
  const reply = await send("/api/answer", { id, ...given }, at)
  if (reply.status === 401 && at !== undefined) throw new PeerRefused("pair")
  const said: { readonly answer?: string; readonly via?: string; readonly at?: number; readonly reason?: string } = await reply.json().catch(() => ({}))
  if (reply.ok) return { tag: "sent" }
  if (reply.status === 409) return { tag: "closed", answer: said.answer, via: said.via, at: said.at }
  return { tag: "refused", status: reply.status, reason: said.reason ?? `the server answered ${reply.status}` }
}
