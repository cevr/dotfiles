// The page's one connection to its server: the view, and the four writes. Every write is a JSON POST with the
// page's header, from the page's own origin (the listener refuses anything else).
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

const post = async (path: string, body: Record<string, string>): Promise<void> => {
  const answer = await fetch(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", [PAGE_HEADER]: "1" } })
  if (!answer.ok) throw new Error(`the server refused it (${answer.status})`)
}

export const markRead = (id: string, read: boolean) => post("./api/mark", { id, mark: read ? "read" : "unread" })
export const setLater = (id: string) => post("./api/later", { id })
export const rename = (project: string, name: string) => post("./api/name", { project, name })
export const firstVisit = () => post("./api/since", {})
