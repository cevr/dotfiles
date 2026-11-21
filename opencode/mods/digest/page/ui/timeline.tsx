// The timeline: the whole history in 6-hour spans (the view's), labelled with day names and hours, a "you last read"
// line, and the project's messages as marks, each at its own time. Wide it runs down the right edge, newest at the
// top; on a phone along the bottom, newest on the right. Hover or drag magnifies a span, shows its card (the span,
// its count, three subjects) and lights its rows; a drag scrolls the list there. For the keyboard it is a slider:
// arrows move one span, Home and End go to the ends, Enter scrolls the list to the span.
import { createSignal, For, Show } from "solid-js"
import { hot, setHot, showAll, shownAll, view, wide } from "./state.ts"
import { inSpan, type Message, type Project, type Span } from "./types.ts"

/** Close marks (within this share of a span) stack beside each other. */
const CROWD = 0.12

const [card, setCard] = createSignal<{ readonly x: number; readonly y: number } | undefined>(undefined)
let dragging = false

const spans = () => view()?.spans ?? []
const isLast = (at: number) => at === spans().length - 1

/** The project's own history: the spans from the one holding its oldest message to now. */
const firstOf = (project: Project): number => {
  const oldest = Math.min(...project.marks.map((mark) => mark.t))
  const at = spans().findIndex((span) => span.end > oldest)
  return at === -1 ? Math.max(0, spans().length - 1) : at
}
const ownSpans = (project: Project) => spans().map((span, at) => ({ span, at })).slice(firstOf(project))

/** The phone's labels under the rail: a day name on every few days, so about seven show. */
const dayLabels = (project: Project) => {
  const own = ownSpans(project)
  const step = Math.max(1, Math.ceil(own.filter((each) => each.span.day !== undefined).length / DAY_LABELS))
  let days = 0
  return own.map((each) => {
    if (each.span.day === undefined) return { at: each.at, day: undefined }
    days += 1
    return { at: each.at, day: (days - 1) % step === 0 ? each.span.day : undefined }
  })
}

/** On a phone the day names thin out to about seven, so they never run into each other. */
const DAY_LABELS = 7

/** Every message of the project, the inbox's and Later's. */
const messagesOf = (project: Project): ReadonlyArray<Message> => [...project.inbox, ...project.later]

/** Scroll the list to time `t`: the newest inbox message at or before it. */
const jump = (project: Project, t: number, smooth: boolean) => {
  const list = project.inbox
  if (list.length === 0) return
  const found = list.findIndex((each) => !each.pinned && each.t <= t)
  const at = found === -1 ? list.length - 1 : found
  if (at >= project.cut && !shownAll().has(`${project.id}|in`)) showAll(`${project.id}|in`)
  requestAnimationFrame(() => document.getElementById(`r-${list[at]?.id ?? ""}`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" }))
}

/** The span under a pointer, and the time it points at inside it. */
const pointAt = (event: PointerEvent): { readonly at: number; readonly t: number } | undefined => {
  const band = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".rail .band")
  if (band === null || band === undefined) return undefined
  const at = Number(band.dataset["i"])
  const span = spans()[at]
  if (span === undefined) return undefined
  const box = band.getBoundingClientRect()
  const share = wide() ? 1 - (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width
  return { at, t: span.start + Math.min(1, Math.max(0, share)) * (span.end - span.start) }
}

function Band(props: { readonly project: Project; readonly span: Span; readonly at: number }) {
  const vertical = () => wide()
  const share = (t: number) => (t - props.span.start) / Math.max(1, props.span.end - props.span.start)
  const pos = (t: number) => `${(vertical() ? 1 - share(t) : share(t)) * 100}%`
  const marks = () => {
    let column = 0
    let previous = -1
    return props.project.marks
      .filter((mark) => inSpan(props.span, mark.t, isLast(props.at)))
      .map((mark) => {
        const here = share(mark.t)
        column = previous >= 0 && here - previous < CROWD ? column + 1 : 0
        previous = here
        return { mark, column: Math.min(column, vertical() ? 4 : 2) }
      })
  }
  const lastRead = () => view()?.lastRead
  return (
    <div class={["band", { hot: hot() === props.at, day: props.span.day !== undefined }]} data-i={String(props.at)}>
      <For each={marks()}>{(each) => <span class={["mark", { unread: each.mark.unread, red: each.mark.red }]} style={{ "--pos": pos(each.mark.t), "--col": String(each.column) }} />}</For>
      <Show when={lastRead() !== undefined && inSpan(props.span, lastRead() ?? 0, isLast(props.at))}>
        <span class="here" style={{ "--pos": pos(lastRead() ?? 0) }} />
        <Show when={vertical()}>
          <span class={["herelabel", { below: isLast(props.at) }]} style={{ "--pos": pos(lastRead() ?? 0) }}>
            you last read
            <br />
            {view()?.lastReadLabel}
          </span>
        </Show>
      </Show>
      <Show when={vertical()}>
        <span class="blabel">
          <Show when={props.span.day}>{(day) => <b>{day()} </b>}</Show>
          {props.span.label}
        </span>
      </Show>
    </div>
  )
}

function Card(props: { readonly project: Project }) {
  const span = () => spans()[hot() ?? -1]
  const inIt = () => {
    const now = span()
    if (now === undefined) return []
    return messagesOf(props.project)
      .filter((each) => inSpan(now, each.t, isLast(hot() ?? -1)))
      .toSorted((a, b) => b.t - a.t)
  }
  const place = () => {
    const at = card()
    if (at === undefined) return {}
    if (wide()) return { top: `${Math.max(0, at.y - 28)}px` }
    return { left: `${Math.max(8, Math.min(at.x - 150, innerWidth - 308))}px` }
  }
  return (
    <Show when={span()}>
      {(now) => (
        <div class="card" role="status" style={place()}>
          <h3>{now().name}</h3>
          <p class="n">{inIt().length > 0 ? `${inIt().length} ${inIt().length === 1 ? "message" : "messages"} in ${props.project.name}` : `Nothing happened in ${props.project.name}.`}</p>
          <ul>
            <For each={inIt().slice(0, 3)}>
              {(each) => (
                <li class={{ unread: each.unread }}>
                  <span>{each.subject}</span>
                  <span class="time">{each.when}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={inIt().length > 3}>
            <p class="n">and {inIt().length - 3} more</p>
          </Show>
        </div>
      )}
    </Show>
  )
}

export function Timeline(props: { readonly project: Project }) {
  let wrap: HTMLElement | undefined
  const point = (event: PointerEvent) => {
    const found = pointAt(event)
    if (found === undefined) return false
    setHot(found.at)
    const box = wrap?.getBoundingClientRect()
    setCard({ x: event.clientX, y: event.clientY - (box?.top ?? 0) })
    if (dragging) jump(props.project, found.t, false)
    return true
  }
  const leave = () => {
    if (dragging) return
    setHot(undefined)
    setCard(undefined)
  }
  const onKey = (event: KeyboardEvent) => {
    const last = spans().length - 1
    const now = hot() ?? last
    const first = firstOf(props.project)
    const next = { ArrowUp: wide() ? now + 1 : now, ArrowDown: wide() ? now - 1 : now, ArrowRight: now + 1, ArrowLeft: now - 1, Home: first, End: last }[event.key]
    if (next !== undefined) {
      event.preventDefault()
      setCard(undefined)
      setHot(Math.max(first, Math.min(last, next)))
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      const span = spans()[now]
      if (span !== undefined) jump(props.project, (span.start + span.end) / 2, true)
    }
  }
  const rail = (
    <div
      class={wide() ? "rail vrail" : "rail hrail"}
      role="slider"
      tabindex="0"
      aria-label="Timeline"
      aria-orientation={wide() ? "vertical" : "horizontal"}
      aria-valuemin={String(firstOf(props.project))}
      aria-valuemax={String(Math.max(0, spans().length - 1))}
      aria-valuenow={String(hot() ?? spans().length - 1)}
      aria-valuetext={spans()[hot() ?? spans().length - 1]?.name ?? ""}
      onPointerDown={(event: PointerEvent) => {
        dragging = true
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
        point(event)
        event.preventDefault()
      }}
      onPointerMove={(event: PointerEvent) => {
        if (event.pointerType === "touch" && !dragging) return
        if (!point(event)) leave()
      }}
      onPointerUp={() => {
        dragging = false
        if (!wide() || !matchMedia("(hover: hover)").matches) leave()
      }}
      onPointerCancel={() => {
        dragging = false
        leave()
      }}
      onPointerLeave={leave}
      onKeyDown={onKey}
      onBlur={leave}
    >
      <For each={wide() ? ownSpans(props.project).toReversed() : ownSpans(props.project)}>
        {(each) => <Band project={props.project} span={each.span} at={each.at} />}
      </For>
    </div>
  )
  return (
    <Show
      when={wide()}
      fallback={
        <div class="scrub" ref={(el: HTMLElement) => (wrap = el)} aria-label="Timeline, newest on the right">
          <div class="cap">
            <span>Timeline</span>
            <Show when={view()?.lastReadLabel}>{(last) => <span class="herecap">│ you last read {last()}</span>}</Show>
            <span>
              <b>Now </b>
              {view()?.nowLabel}
            </span>
          </div>
          {rail}
          <div class="hlabels" aria-hidden="true">
            <For each={dayLabels(props.project)}>{(each) => <span class={{ hot: hot() === each.at }}>{each.day === undefined ? "" : <b>{each.day}</b>}</span>}</For>
          </div>
          <Card project={props.project} />
        </div>
      }
    >
      <aside class="railwrap" ref={(el: HTMLElement) => (wrap = el)} aria-label="Timeline, newest at the top">
        <h2>Timeline</h2>
        <p class="now">
          <b>Now</b>
          {view()?.nowLabel}
        </p>
        {rail}
        <p class="end">Start of history</p>
        <Card project={props.project} />
      </aside>
    </Show>
  )
}
