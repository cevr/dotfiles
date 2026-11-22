// The page's state: the view the server last answered (kept through a restart), and what is only the page's own:
// the project entered, the message open, the rows shown past "earlier", the span the timeline points at.
import { createSignal } from "solid-js"
import * as Api from "./api.ts"
import type { Message, Project, View } from "./types.ts"

/** How often the page asks again while it is visible; a write or a return to the tab asks at once. */
const REFRESH_MS = 20_000

const query = new URLSearchParams(location.search)

export const [view, setView] = createSignal<View | undefined>(undefined)
/** Why the last ask failed; the last view stays on screen. */
export const [problem, setProblem] = createSignal<string | undefined>(undefined)
export const [projectId, setProjectId] = createSignal<string | undefined>(query.get("p") ?? undefined)
export const [openId, setOpenId] = createSignal<string | undefined>(undefined)
export const [shownAll, setShownAll] = createSignal<ReadonlySet<string>>(new Set())
/** The timeline span pointed at (hovered, dragged or focused), by index. */
export const [hot, setHot] = createSignal<number | undefined>(undefined)
export const [editing, setEditing] = createSignal(false)

const wideQuery = matchMedia("(min-width: 900px)")
export const [wide, setWide] = createSignal(wideQuery.matches)
wideQuery.addEventListener("change", () => setWide(wideQuery.matches))

/** The project entered: the chosen one, else (wide) the first. */
export const project = (): Project | undefined => {
  const all = view()?.projects ?? []
  const chosen = all.find((each) => each.id === projectId())
  if (chosen !== undefined || !wide()) return chosen
  return all[0]
}

/** Enter a project (none: back to the list on a phone). */
export const enter = (id: string | undefined) => {
  setProjectId(id)
  setOpenId(undefined)
  setEditing(false)
  setHot(undefined)
  history.replaceState(null, "", id === undefined ? location.pathname : `?p=${encodeURIComponent(id)}`)
  scrollTo(0, 0)
}

export const showAll = (key: string) => setShownAll((all) => new Set([...all, key]))

let asking: Promise<void> | undefined

/** Ask for the view now. */
export const refresh = (): Promise<void> => {
  if (asking !== undefined) return asking
  const ask: Promise<void> = Api.fetchView()
    .then(async (next) => {
      setView(next)
      setProblem(undefined)
      // His first visit: everything older reads as read from now on. Only the first-ever load writes it.
      if (next.since === undefined) {
        await Api.firstVisit()
        setView(await Api.fetchView())
      }
    })
    .catch((failure: Error) => void setProblem(failure.message))
    .finally(() => {
      asking = undefined
    })
  asking = ask
  return ask
}

/** A write, then the view again; a refused write shows as the problem. */
const act = (write: Promise<void>) =>
  write.then(refresh).catch((failure: Error) => void setProblem(failure.message))

/** Open a message in place (marking it read), or close the one open. */
export const toggleOpen = (message: Message) => {
  if (openId() === message.id) return setOpenId(undefined)
  setOpenId(message.id)
  if (message.unread) void act(Api.markRead(message.id, true))
}

export const toggleRead = (message: Message) => void act(Api.markRead(message.id, message.unread))

/** Set a message aside until the morning, or bring one back to the inbox (unread). */
export const toggleLater = (message: Message) => {
  if (openId() === message.id) setOpenId(undefined)
  void act(message.returnsAt === undefined ? Api.setLater(message.id) : Api.markRead(message.id, false))
}

export const renameProject = (id: string, name: string) => void act(Api.rename(id, name))

// ── Answers ──

/** Whether this browser is paired (may answer); unknown until /paired.json answers. */
export const [paired, setPaired] = createSignal<boolean | undefined>(undefined)
/** The last pairing try's refusal, shown under the code field. */
export const [pairProblem, setPairProblem] = createSignal<string | undefined>(undefined)
/** What became of each answer sent from this page, by message id. */
export const [outcomes, setOutcomes] = createSignal<ReadonlyMap<string, Api.Outcome>>(new Map())
/** The messages whose answer is on its way. */
export const [sending, setSending] = createSignal<ReadonlySet<string>>(new Set())

/** A code (typed, or from the link's `#pair=`) exchanged for this browser's cookie. */
export const pairWith = (code: string) =>
  Api.pair(code.trim())
    .then(() => {
      setPairProblem(undefined)
      setPaired(true)
    })
    .catch((failure: Error) => {
      setPairProblem(failure.message)
      return Api.fetchPaired().then(setPaired).catch(() => void setPaired(false))
    })

/** His answer to `message`: sent once (a second press while it goes does nothing), then the view again. */
export const answerMessage = (message: Message, given: { readonly option: string } | { readonly text: string }) => {
  if (sending().has(message.id)) return
  setSending((all) => new Set([...all, message.id]))
  void Api.answer(message.id, given)
    .then((outcome) => {
      setOutcomes((all) => new Map([...all, [message.id, outcome]]))
      // A cookie the server no longer knows (the pairing file deleted): pair again.
      if (outcome.tag === "refused" && outcome.status === 401) setPaired(false)
    })
    .catch((failure: Error) => void setOutcomes((all) => new Map([...all, [message.id, { tag: "refused", status: 0, reason: failure.message }]])))
    .finally(() => {
      setSending((all) => new Set([...all].filter((id) => id !== message.id)))
      void refresh()
    })
}

/** The link's `#pair=<code>`, taken once and cleared from the address bar so a reload never replays it. */
const pairFromLink = () => {
  const code = new URLSearchParams(location.hash.slice(1)).get("pair")
  if (code === null) return Api.fetchPaired().then(setPaired).catch(() => void setPaired(false))
  history.replaceState(null, "", `${location.pathname}${location.search}`)
  return pairWith(code)
}

/** Keep the view fresh while the page is visible. */
export const start = () => {
  void pairFromLink()
  // A pairing link opened in a tab that already shows the page changes only its hash.
  addEventListener("hashchange", () => void pairFromLink())
  void refresh()
  setInterval(() => {
    if (document.visibilityState === "visible") void refresh()
  }, REFRESH_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh()
  })
}
