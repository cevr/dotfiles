// The page's one connection to its server: the view, whether this browser is paired, and the writes. Every write is
// a JSON POST with the page's header, from the page's own origin (the listener refuses anything else); an answer
// needs this browser paired too (its HttpOnly cookie, which the page never reads: it asks /paired.json).
import type { View } from "./types.ts"

const PAGE_HEADER = "x-digest-page"

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
  fetch(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", [PAGE_HEADER]: "1" } })

const post = async (path: string, body: Record<string, string>): Promise<void> => {
  const answer = await send(path, body)
  if (!answer.ok) throw new Error(`the server refused it (${answer.status})`)
}

export const markRead = (id: string, read: boolean) => post("./api/mark", { id, mark: read ? "read" : "unread" })
export const setLater = (id: string) => post("./api/later", { id })
export const rename = (project: string, name: string) => post("./api/name", { project, name })
export const firstVisit = () => post("./api/since", {})

/** Whether this browser holds the digest's pairing cookie. */
export const fetchPaired = async (): Promise<boolean> => {
  const answer = await fetch("./paired.json", { cache: "no-store" })
  if (!answer.ok) return false
  const said: { readonly paired?: boolean } = await answer.json()
  return said.paired === true
}

/** A pairing code exchanged for this browser's cookie; a refusal says why (used, out of time, too many tries). */
export const pair = async (code: string): Promise<void> => {
  const answer = await send("./api/pair", { code })
  if (answer.ok) return
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
