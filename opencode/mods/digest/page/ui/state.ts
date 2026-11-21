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

/** Keep the view fresh while the page is visible. */
export const start = () => {
  void refresh()
  setInterval(() => {
    if (document.visibilityState === "visible") void refresh()
  }, REFRESH_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh()
  })
}
