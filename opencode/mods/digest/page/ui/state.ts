// The page's state: the view the server last answered (kept through a restart), and what is only the page's own:
// the project entered, the message open, the rows shown past "earlier", the span the timeline points at.
import { createSignal } from "solid-js"
import * as Api from "./api.ts"
import { isPeer, type Message, ownId, type Project, type View } from "./types.ts"

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
/** The page on the tailnet, not paired: it shows only how to pair, and no data. */
export const [locked, setLocked] = createSignal(false)
/**
 * The page on the tailnet with reading open (digest.tailnetRead "member") but marking not (an agent machine, or
 * tailnetWrite "paired"), not paired: a mark was refused, so it shows the digest, opens messages without marking
 * them, and offers pairing to mark and answer. On one of his devices with writes open, no mark is refused, so this
 * never shows.
 */
export const [marksLocked, setMarksLocked] = createSignal(false)

/** A mark refused for want of pairing: a token it kept is no longer known (or there is none), so it is forgotten. */
const markRefused = () => {
  Api.keepToken("")
  setAnswers(false)
  setMarksLocked(true)
}

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
      setLocked(false)
      setProblem(undefined)
      // His first visit: everything older reads as read from now on. Only the first-ever load writes it, and only a
      // browser that may mark: an unpaired reader on the tailnet leaves it for one that may.
      if (next.since === undefined && !marksLocked()) {
        const wrote = await Api.firstVisit().then(
          () => true,
          (failure: Error) => {
            if (!(failure instanceof Api.MarkUnpaired)) throw failure
            markRefused()
            return false
          },
        )
        if (wrote) setView(await Api.fetchView())
      }
    })
    .catch((failure: Error) => {
      // Not paired here (its token revoked, or a new origin): nothing of the last view stays on screen.
      if (failure instanceof Api.Unpaired) {
        Api.keepToken("")
        setView(undefined)
        setAnswers(false)
        setProblem(undefined)
        return void setLocked(true)
      }
      setProblem(failure.message)
    })
    .finally(() => {
      asking = undefined
    })
  asking = ask
  return ask
}

/** A write, then the view again; a write refused for want of pairing offers pairing, any other shows as the problem. */
const act = (write: Promise<void>) =>
  write.then(refresh).catch((failure: Error) => {
    if (failure instanceof Api.MarkUnpaired) return markRefused()
    setProblem(failure.message)
  })

// ── A peer's items: written straight to their own host ──

/**
 * The peers' pages this browser cannot write to from here, by origin: `pair`, the peer needs this browser paired on
 * its own page (an agent machine's browser); `unreachable`, the peer is down or does not let this page write.
 */
export const [peerLocked, setPeerLocked] = createSignal<ReadonlyMap<string, "pair" | "unreachable">>(new Map())

/** The peer's page (its origin) that owns the project or message `id`; none for this host's own. */
export const peerOrigin = (id: string): string | undefined =>
  isPeer(id) ? view()?.projects.find((each) => each.id === id || each.inbox.some((one) => one.id === id) || each.later.some((one) => one.id === id))?.origin : undefined

/** Whether this browser may mark, set aside, rename or answer `id` from this page. */
export const mayAct = (id: string): boolean => {
  if (!isPeer(id)) return !marksLocked()
  const at = peerOrigin(id)
  return at !== undefined && !peerLocked().has(at)
}

/** A write to the item `id`: to this host, or to the peer that owns it (its id as that host knows it). */
const write = (id: string, toHost: (id: string) => Promise<void>, toPeer: (id: string, at: string) => Promise<void>) => {
  const at = peerOrigin(id)
  if (!isPeer(id)) return void act(toHost(id))
  if (at === undefined || peerLocked().has(at)) return
  void toPeer(ownId(id), at)
    .then(refresh)
    .catch((failure: Error) => {
      if (failure instanceof Api.PeerRefused) return void setPeerLocked((all) => new Map([...all, [at, failure.why]]))
      setProblem(failure.message)
    })
}

/** Open a message in place (marking it read, when this browser may mark), or close the one open. */
export const toggleOpen = (message: Message) => {
  if (openId() === message.id) return setOpenId(undefined)
  setOpenId(message.id)
  if (message.unread && mayAct(message.id)) write(message.id, (id) => Api.markRead(id, true), (id, at) => Api.markRead(id, true, at))
}

export const toggleRead = (message: Message) => write(message.id, (id) => Api.markRead(id, message.unread), (id, at) => Api.markRead(id, message.unread, at))

/** Set a message aside until the morning, or bring one back to the inbox (unread). */
export const toggleLater = (message: Message) => {
  if (openId() === message.id) setOpenId(undefined)
  write(
    message.id,
    (id) => (message.returnsAt === undefined ? Api.setLater(id) : Api.markRead(id, false)),
    (id, at) => (message.returnsAt === undefined ? Api.setLater(id, at) : Api.markRead(id, false, at)),
  )
}

export const renameProject = (id: string, name: string) => write(id, (own) => Api.rename(own, name), (own, at) => Api.rename(own, name, at))

// ── Answers ──

/**
 * Whether this browser may answer: paired, or one of his own devices where the tailnet's writes are open; unknown
 * until /paired.json answers. No: the page offers pairing where an answer would go.
 */
export const [answers, setAnswers] = createSignal<boolean | undefined>(undefined)
/** The last pairing try's refusal, shown under the code field. */
export const [pairProblem, setPairProblem] = createSignal<string | undefined>(undefined)
/** What became of each answer sent from this page, by message id. */
export const [outcomes, setOutcomes] = createSignal<ReadonlyMap<string, Api.Outcome>>(new Map())
/** The messages whose answer is on its way. */
export const [sending, setSending] = createSignal<ReadonlySet<string>>(new Set())

/** A code (typed, or from the link's `#pair=`) exchanged for this browser's token. */
export const pairWith = (code: string) =>
  Api.pair(code.trim())
    .then(() => {
      setPairProblem(undefined)
      setAnswers(true)
      setMarksLocked(false)
      return refresh()
    })
    .catch((failure: Error) => {
      setPairProblem(failure.message)
      return Api.fetchAnswers().then(setAnswers).catch(() => void setAnswers(false))
    })

/** His answer to `message`: sent once (a second press while it goes does nothing), then the view again. */
export const answerMessage = (message: Message, given: { readonly option: string } | { readonly text: string }) => {
  const at = peerOrigin(message.id)
  if (sending().has(message.id) || (isPeer(message.id) && !mayAct(message.id))) return
  setSending((all) => new Set([...all, message.id]))
  void Api.answer(ownId(message.id), given, at)
    .then((outcome) => {
      setOutcomes((all) => new Map([...all, [message.id, outcome]]))
      // A token the server no longer knows (revoked, or the pairing file deleted): forget it, and pair again.
      if (outcome.tag === "refused" && outcome.status === 401 && at === undefined) {
        Api.keepToken("")
        setAnswers(false)
      }
    })
    .catch((failure: Error) => {
      // A peer that needs this browser paired, or cannot be written from here: the message says where to act.
      if (failure instanceof Api.PeerRefused && at !== undefined) return void setPeerLocked((all) => new Map([...all, [at, failure.why]]))
      setOutcomes((all) => new Map([...all, [message.id, { tag: "refused", status: 0, reason: failure.message }]]))
    })
    .finally(() => {
      setSending((all) => new Set([...all].filter((id) => id !== message.id)))
      void refresh()
    })
}

/** The link's `#pair=<code>`, taken once and cleared from the address bar so a reload never replays it. */
const pairFromLink = () => {
  const code = new URLSearchParams(location.hash.slice(1)).get("pair")
  if (code === null) return Api.fetchAnswers().then(setAnswers).catch(() => void setAnswers(false))
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
