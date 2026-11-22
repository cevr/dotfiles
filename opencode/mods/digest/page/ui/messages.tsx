// A project's messages: its name (renamed in place), then its rows as an Accordion, one open at a time, the opened
// one's detail indented under it: body, the answer's place when it needs him, then units, a unit's rounds and their
// evidence files, each one level deeper. Phone: swipe right reads or unreads a row, swipe left sets it aside for
// Later; on any width U and L do the same on a focused row, and the opened message has both as buttons.
import { createSignal, For, Show } from "solid-js"
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "@ui-sdk/solid/accordion"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/solid/collapsible"
import type { Outcome } from "./api.ts"
import { answerMessage, editing, enter, hot, openId, outcomes, paired, pairProblem, pairWith, renameProject, sending, setEditing, showAll, shownAll, toggleLater, toggleOpen, toggleRead, view, wide } from "./state.ts"
import { type Ask, inSpan, type Message, type Project, type Unit } from "./types.ts"

/** How far a row must travel before its swipe acts, in px. */
const SWIPE_AT = 88

const KIND: Readonly<Record<Message["kind"], string>> = { shipped: "Done", stuck: "In progress", needs: "Needs you", decided: "You decided", fyi: "For your information" }

/** Whether the timeline points at the span `t` is in. */
const lit = (t: number): boolean => {
  const at = hot()
  const spans = view()?.spans ?? []
  if (at === undefined || spans[at] === undefined) return false
  return inSpan(spans[at], t, at === spans.length - 1)
}

// ── Swipe (narrow screens): the row slides, the action shows under it ──

interface Swipe {
  readonly row: HTMLElement
  readonly message: Message
  readonly x: number
  readonly y: number
  dx: number
  on: boolean
}

let swipe: Swipe | undefined
let swipeEnded = 0

const startSwipe = (event: PointerEvent, message: Message) => {
  if (wide() || !(event.currentTarget instanceof HTMLElement)) return
  swipe = { row: event.currentTarget, message, x: event.clientX, y: event.clientY, dx: 0, on: false }
}

addEventListener("pointermove", (event) => {
  const now = swipe
  if (now === undefined) return
  const dx = event.clientX - now.x
  const dy = event.clientY - now.y
  if (!now.on) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) now.on = true
    else if (Math.abs(dy) > 12) swipe = undefined
  }
  if (!now.on) return
  now.dx = dx
  const shell = now.row.closest<HTMLElement>(".swipe")
  now.row.style.transform = `translateX(${dx}px)`
  if (shell === null) return
  shell.dataset["dir"] = dx > 0 ? "r" : "l"
  shell.classList.toggle("armed", Math.abs(dx) >= SWIPE_AT)
})

const endSwipe = (event: PointerEvent) => {
  const ended = swipe
  swipe = undefined
  if (ended === undefined || !ended.on) return
  swipeEnded = Date.now()
  ended.row.style.transform = ""
  const shell = ended.row.closest<HTMLElement>(".swipe")
  if (shell !== null) {
    delete shell.dataset["dir"]
    shell.classList.remove("armed")
  }
  if (event.type !== "pointerup" || Math.abs(ended.dx) < SWIPE_AT) return
  if (ended.dx > 0) toggleRead(ended.message)
  else toggleLater(ended.message)
}
addEventListener("pointerup", endSwipe)
addEventListener("pointercancel", endSwipe)

// ── The opened message ──

/** A unit's rounds in a few words: `round 1 changes → round 2 accepted`. */
const pathOf = (unit: Unit): string =>
  unit.rounds.map((round) => `round ${round.n} ${round.verdict ?? (round.handed === undefined ? "in work" : "handed back, not verified yet")}`).join(" → ") || "no round yet"

function UnitBlock(props: { readonly unit: Unit }) {
  const last = () => props.unit.rounds.at(-1)?.verdict
  return (
    <Collapsible class="nest">
      <CollapsibleTrigger class="disc">
        <span class="chev" aria-hidden="true">›</span>
        <span class="uname">{props.unit.name}</span>
        <span class={["path", { ok: last() === "accepted", bad: last() !== undefined && last() !== "accepted" }]}>{pathOf(props.unit)}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel class="inner">
        <Show when={props.unit.purpose}>{(purpose) => <p class="muted">{purpose()}</p>}</Show>
        <For each={props.unit.rounds}>
          {(round) => (
            <div class="round">
              <p>
                Round {round.n}
                {round.verdict === undefined ? "" : `: ${round.verdict}`}
                {round.batch === undefined ? "" : ` in ${round.batch}`}
              </p>
              <Show when={round.request !== undefined || round.findings !== undefined}>
                <ul class="evidence" aria-label={`Round ${round.n}'s files`}>
                  <Show when={round.request}>{(path) => <li><span class="muted">request</span> <code>{path()}</code></li>}</Show>
                  <Show when={round.findings}>{(path) => <li><span class="muted">findings</span> <code>{path()}</code></li>}</Show>
                </ul>
              </Show>
            </div>
          )}
        </For>
      </CollapsiblePanel>
    </Collapsible>
  )
}

/** Where an answer was given, as he reads it. */
const VIA: Readonly<Record<string, string>> = { tray: "OpenCode tray", page: "digest page" }

/** A time in the view's zone, short. */
const clock = (t: number): string => new Date(t).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: view()?.zone })

/** What became of the answer he sent from here. */
function OutcomeLine(props: { readonly outcome: Outcome }) {
  const said = (): string => {
    const outcome = props.outcome
    if (outcome.tag === "sent") return "Sent. The run has your answer."
    if (outcome.tag === "closed") {
      const where = outcome.via === undefined ? "" : ` in the ${VIA[outcome.via] ?? outcome.via}`
      const when = outcome.at === undefined ? "" : ` at ${clock(outcome.at)}`
      return `Already answered${where}${when}${outcome.answer === undefined ? "" : `: ${outcome.answer}`}. Yours was not sent.`
    }
    return `Not sent: ${outcome.reason}`
  }
  return (
    <p class={["outcome", { bad: props.outcome.tag !== "sent" }]} role="status">
      {said()}
    </p>
  )
}

/**
 * How to pair this browser: the command, and a field for the code it prints. `read`: the page on the tailnet, which
 * shows nothing until this browser pairs; else to answer.
 */
export function PairPrompt(props: { readonly read?: boolean }) {
  let field: HTMLInputElement | undefined
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (field !== undefined && field.value.trim() !== "") void pairWith(field.value)
  }
  return (
    <form class="pair" onSubmit={submit}>
      <Show
        when={props.read}
        fallback={
          <p>
            Pair this browser to answer: run <code>bun cmd/digest/pair.ts</code> and open the link it prints, or type its code here.
          </p>
        }
      >
        <p>
          Pair this browser to read the digest: on the host, run <code>bun cmd/digest/pair.ts</code> and type the code it prints here. Each address of the page (its name, its IP) pairs on its own.
        </p>
      </Show>
      <div class="pairrow">
        <input ref={(input: HTMLInputElement) => (field = input)} aria-label="Pairing code" placeholder="ABCDE-FGHJK" autocomplete="one-time-code" maxlength={16} />
        <button type="submit">Pair</button>
      </div>
      <Show when={pairProblem()}>{(why) => <p class="outcome bad" role="alert">{why()}</p>}</Show>
    </form>
  )
}

/** His answer to an open message: its options as buttons, his own words, and what happens if he does nothing. */
function AskBlock(props: { readonly message: Message; readonly ask: Ask }) {
  let field: HTMLTextAreaElement | undefined
  const busy = () => sending().has(props.message.id)
  const can = () => paired() === true && props.message.open && !busy()
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const text = field?.value.trim() ?? ""
    if (text !== "" && can()) answerMessage(props.message, { text })
  }
  return (
    <div class="ask">
      <Show when={props.ask.options.length > 0}>
        <div class="opts" role="group" aria-label="Answers">
          <For each={props.ask.options}>
            {(option) => (
              <button type="button" class="opt" disabled={!can()} onClick={() => answerMessage(props.message, { option })}>
                {option}
              </button>
            )}
          </For>
        </div>
      </Show>
      <form class="own" onSubmit={submit}>
        <textarea ref={(input: HTMLTextAreaElement) => (field = input)} aria-label="Your own answer" placeholder="Or answer in your own words" rows={2} maxlength={4000} disabled={!can()} />
        <button type="submit" disabled={!can()}>
          {busy() ? "Sending…" : "Send"}
        </button>
      </form>
      <p class="assume">{props.ask.assume === undefined ? "If you do nothing, the run waits for you: it has no assumption for this one." : `If you do nothing, the run goes on assuming: ${props.ask.assume}`}</p>
      <Show when={paired() === false}>
        <PairPrompt />
      </Show>
    </div>
  )
}

function Detail(props: { readonly message: Message }) {
  return (
    <div class="detail">
      <p class="meta">
        {KIND[props.message.kind]} · {props.message.when}
        {props.message.returnsAt === undefined ? "" : ` · back ${new Date(props.message.returnsAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: view()?.zone })}`}
      </p>
      <Show when={props.message.body !== ""}>
        <p class="body">{props.message.body}</p>
      </Show>
      <Show when={props.message.ask}>{(ask) => <AskBlock message={props.message} ask={ask()} />}</Show>
      <Show when={outcomes().get(props.message.id)}>{(outcome) => <OutcomeLine outcome={outcome()} />}</Show>
      <Show when={props.message.decided}>
        {(decided) => (
          <dl class="decided">
            <For each={decided()}>
              {(each) => (
                <>
                  <dt>{each.q}</dt>
                  <dd>
                    You said: <b>{each.said}</b>
                    {each.via === undefined ? "" : ` (in the ${VIA[each.via] ?? each.via})`} · the run had assumed: {each.assumed}
                  </dd>
                </>
              )}
            </For>
          </dl>
        )}
      </Show>
      <Show when={props.message.units.length > 0}>
        <div class="deeper">
          <Collapsible class="nest">
            <CollapsibleTrigger class="disc">
              <span class="chev" aria-hidden="true">›</span>
              Units and rounds ({props.message.units.length})
            </CollapsibleTrigger>
            <CollapsiblePanel class="inner">
              <For each={props.message.units}>{(unit) => <UnitBlock unit={unit} />}</For>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </Show>
      <div class="acts">
        <button type="button" onClick={() => toggleRead(props.message)}>
          {props.message.unread ? "Mark read" : "Mark unread"}
        </button>
        <button type="button" onClick={() => toggleLater(props.message)}>
          {props.message.returnsAt === undefined ? "Later" : "Back to the inbox"}
        </button>
      </div>
    </div>
  )
}

// ── Rows ──

function Row(props: { readonly message: Message }) {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === "u" || event.key === "U") toggleRead(props.message)
    else if (event.key === "l" || event.key === "L") toggleLater(props.message)
  }
  return (
    <AccordionItem value={props.message.id} class="msg">
      <div class="swipe">
        <div class="under" aria-hidden="true">
          <span class="ul">{props.message.unread ? "Mark read" : "Mark unread"}</span>
          <span class="ur">{props.message.returnsAt === undefined ? "Later" : "Back to the inbox"}</span>
        </div>
        <AccordionHeader class="rowhead">
          <AccordionTrigger
            class={["row", { unread: props.message.unread, at: lit(props.message.t) }]}
            id={`r-${props.message.id}`}
            data-t={String(props.message.t)}
            aria-keyshortcuts="U L"
            onPointerDown={(event: PointerEvent) => startSwipe(event, props.message)}
            onKeyDown={onKey}
          >
            <span class="dot" aria-label={props.message.unread ? "unread" : undefined} />
            <span class="subj">
              <Show when={props.message.level === "red"}>
                <span class="word red">{props.message.open ? "Urgent" : "Blocked"}</span>
                {" · "}
              </Show>
              <Show when={props.message.level !== "red" && props.message.open}>
                <span class="word need">Needs you</span>
                {" · "}
              </Show>
              {props.message.subject}
            </span>
            <span class="time">{props.message.when}</span>
          </AccordionTrigger>
        </AccordionHeader>
      </div>
      <AccordionPanel class="panel" hiddenUntilFound>
        <Detail message={props.message} />
      </AccordionPanel>
    </AccordionItem>
  )
}

/** Rows as one Accordion: `cut` shown until "earlier" is pressed. */
function Rows(props: { readonly messages: ReadonlyArray<Message>; readonly cut: number; readonly key: string; readonly label: string }) {
  const all = () => shownAll().has(props.key)
  const openIds = (): Array<string> => {
    const id = openId()
    return id === undefined ? [] : [id]
  }
  const shown = () => (all() ? props.messages : props.messages.slice(0, props.cut))
  const onChange = (value: ReadonlyArray<unknown>, details: { readonly cancel: () => void }) => {
    // A swipe that just ended is not a press.
    if (Date.now() - swipeEnded < 350) return details.cancel()
    const opened = value.find((each) => each !== openId())
    const message = props.messages.find((each) => each.id === (opened ?? openId()))
    if (message !== undefined) toggleOpen(message)
  }
  return (
    <>
      <Accordion class="rows" aria-label={props.label} value={openIds()} onValueChange={onChange} hiddenUntilFound>
        <For each={shown()}>{(message) => <Row message={message} />}</For>
      </Accordion>
      <Show when={!all() && props.messages.length > props.cut}>
        <button type="button" class="more" onClick={() => showAll(props.key)}>
          {props.messages.length - props.cut} earlier
        </button>
      </Show>
    </>
  )
}

function Name(props: { readonly project: Project }) {
  const [draft, setDraft] = createSignal("")
  // Solid 2 shows a write to a signal only after its flush, so Enter right after typing, or the blur that follows
  // Enter, would read the old draft or a stale `editing`: commit from the field itself, once.
  let field: HTMLInputElement | undefined
  const done = (keep: boolean) => {
    const input = field
    if (input === undefined) return
    field = undefined
    setEditing(false)
    const name = input.value.trim()
    if (keep && name !== props.project.name) renameProject(props.project.id, name === props.project.defaultName ? "" : name)
  }
  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          class="rename"
          title="Rename this project"
          aria-label={`${props.project.name}. Rename this project`}
          onClick={() => {
            setDraft(props.project.name)
            setEditing(true)
          }}
        >
          {props.project.name}
        </button>
      }
    >
      <input
        class="rename-in"
        aria-label="Project name"
        maxlength={80}
        value={draft()}
        ref={(input: HTMLInputElement) => {
          field = input
          queueMicrotask(() => input.select())
        }}
        onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) => setDraft(event.currentTarget.value)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Enter") done(true)
          if (event.key === "Escape") done(false)
        }}
        onBlur={() => done(true)}
      />
    </Show>
  )
}

/** A project's screen: name, state, rows, Later. */
export function Messages(props: { readonly project: Project }) {
  return (
    <section class="list">
      <Show when={!wide()}>
        <button type="button" class="back" onClick={() => enter(undefined)}>
          ‹ Projects
        </button>
      </Show>
      <h1>
        <Name project={props.project} />
      </h1>
      <p class="sub">
        {props.project.where} · {props.project.unread > 0 ? `${props.project.unread} unread` : "all read"}
      </p>
      <Show when={props.project.inbox.length > 0} fallback={<p class="none">Nothing here.</p>}>
        <Rows messages={props.project.inbox} cut={props.project.cut} key={`${props.project.id}|in`} label="Messages" />
      </Show>
      <Show when={props.project.later.length > 0}>
        <h3 class="group">Later ({props.project.later.length})</h3>
        <Rows messages={props.project.later} cut={props.project.later.length} key={`${props.project.id}|later`} label="Later" />
      </Show>
    </section>
  )
}
