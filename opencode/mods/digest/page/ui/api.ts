// The page's one connection to its server: the view, whether this browser is paired, and the writes. Every write is
// a JSON POST with the page's header, from the page's own origin (the listener refuses anything else). An answer
// needs this browser paired: the token `/api/pair` answered, kept in this origin's localStorage (scheme, host and
// port: no other server on 127.0.0.1 reads it, as it would a cookie) and sent as TOKEN_HEADER. It never goes in a URL.
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

/** The view now; a failure says why (the server restarting, a marks file of a newer build). */
export const fetchView = async (): Promise<View> => {
  const answer = await fetch("./view.json", { cache: "no-store" })
  if (!answer.ok) {
    const said = await answer.json().catch(() => ({ reason: `the server answered ${answer.status}` }))
    throw new Error(said.reason ?? `the server answered ${answer.status}`)
  }
  return answer.json()
}

const send = (path: string, body: Record<string, string>): Promise<Response> =>
  fetch(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", [PAGE_HEADER]: "1", ...paired() } })

const post = async (path: string, body: Record<string, string>): Promise<void> => {
  const answer = await send(path, body)
  if (!answer.ok) throw new Error(`the server refused it (${answer.status})`)
}

export const markRead = (id: string, read: boolean) => post("./api/mark", { id, mark: read ? "read" : "unread" })
export const setLater = (id: string) => post("./api/later", { id })
export const rename = (project: string, name: string) => post("./api/name", { project, name })
export const firstVisit = () => post("./api/since", {})

/** Whether this browser's token is one the digest knows (none kept: not paired, without asking). */
export const fetchPaired = async (): Promise<boolean> => {
  if (token() === "") return false
  const answer = await fetch("./paired.json", { cache: "no-store", headers: paired() })
  if (!answer.ok) return false
  const said: { readonly paired?: boolean } = await answer.json()
  return said.paired === true
}

/** A pairing code exchanged for this browser's token, kept; a refusal says why (used, out of time, too many tries). */
export const pair = async (code: string): Promise<void> => {
  const answer = await send("./api/pair", { code })
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

/** His answer to the message `id`: one of its options, or his own words. */
export const answer = async (id: string, given: { readonly option: string } | { readonly text: string }): Promise<Outcome> => {
  const reply = await send("./api/answer", { id, ...given })
  const said: { readonly answer?: string; readonly via?: string; readonly at?: number; readonly reason?: string } = await reply.json().catch(() => ({}))
  if (reply.ok) return { tag: "sent" }
  if (reply.status === 409) return { tag: "closed", answer: said.answer, via: said.via, at: said.at }
  return { tag: "refused", status: reply.status, reason: said.reason ?? `the server answered ${reply.status}` }
}
