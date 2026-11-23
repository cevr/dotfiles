// The projects: a Listbox on the left when wide (arrow keys and typeahead move between them), the first screen on a
// phone. Each shows its name, its one line of state and its unread count; colour only from data (red from a red
// level, "Needs you" from an open question).
import { For, Show } from "solid-js"
import { Listbox, ListboxItem } from "@ui-sdk/solid/listbox"
import { enter, project, view } from "./state.ts"
import type { PeerStatus, Project } from "./types.ts"

/** The project's level word: Blocked (red), Needs you: n (open questions), or nothing. */
export function Level(props: { readonly project: Project }) {
  return (
    <Show when={props.project.level === "red" || props.project.needs > 0}>
      <span class={["word", { red: props.project.level === "red", need: props.project.level !== "red" }]}>
        {props.project.level === "red" ? (props.project.needs > 0 ? "Urgent" : "Blocked") : `Needs you: ${props.project.needs}`}
      </span>
    </Show>
  )
}

/** Whether the page shows more than one host: then each project says which it is on. */
const manyHosts = () => (view()?.peers?.length ?? 0) > 0

/** The host a project is on, before its line, when the page shows more than one. */
function Host(props: { readonly project: Project }) {
  return (
    <Show when={manyHosts() && props.project.host !== undefined}>
      <span class="host">{props.project.host}</span>
      <Show when={props.project.headline !== ""}>{" · "}</Show>
    </Show>
  )
}

/** A host whose projects are not in: why, and when it was last read. */
const peerLine = (peer: PeerStatus): string =>
  peer.state === "update"
    ? `${peer.name} runs a build this page cannot read: its projects show again once both hosts are updated.`
    : `${peer.name} is unavailable${peer.lastSeenLabel === undefined ? "" : `, last seen ${peer.lastSeenLabel}`}.`

/** The other hosts whose projects are not in this view, each on its own line; nothing when every host is in. */
export function Peers() {
  const out = () => (view()?.peers ?? []).filter((peer) => peer.state !== "up")
  return (
    <Show when={out().length > 0}>
      <ul class="peers" aria-label="Other hosts">
        <For each={out()}>{(peer) => <li title={peer.reason}>{peerLine(peer)}</li>}</For>
      </ul>
    </Show>
  )
}

/** Wide: the list on the left. */
export function ProjectsSide() {
  return (
    <nav class="side" aria-label="Projects">
      <h2 id="projects-title">Projects</h2>
      <Listbox aria-labelledby="projects-title" value={project()?.id} onValueChange={(value) => enter(String(value))}>
        <For each={view()?.projects ?? []}>
          {(each) => (
            <ListboxItem value={each.id}>
              <span class="top">
                <span class="name">{each.name}</span>
                <Show when={each.unread > 0}>
                  <span class="count" aria-label={`${each.unread} unread`}>
                    {each.unread}
                  </span>
                </Show>
              </span>
              <span class="state">
                <Host project={each} />
                {each.headline}
              </span>
              <span class="lvl">
                <Level project={each} />
              </span>
            </ListboxItem>
          )}
        </For>
      </Listbox>
      <Peers />
    </nav>
  )
}

/** Phone: the first screen. */
export function ProjectsHome() {
  return (
    <div class="phone home">
      <h1>Projects</h1>
      <p class="sub">
        <Show when={view()?.lastReadLabel} fallback={`It is ${view()?.nowLabel ?? ""}.`}>
          {(last) => `You last read ${last()}. It is ${view()?.nowLabel ?? ""}.`}
        </Show>
      </p>
      <Peers />
      <Show when={(view()?.projects.length ?? 0) > 0} fallback={<p class="none">No projects yet. A run's first lane makes one.</p>}>
        <ul class="projects">
          <For each={view()?.projects ?? []}>
            {(each) => (
              <li class={{ read: each.unread === 0 }}>
                <button type="button" onClick={() => enter(each.id)}>
                  <span class="prow">
                    <span class="name">{each.name}</span>
                    <Level project={each} />
                    <Show when={each.unread > 0} fallback={<span class="time">all read</span>}>
                      <span class="count">{each.unread} new</span>
                    </Show>
                  </span>
                  <span class="pline">
                    <Host project={each} />
                    {each.headline}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
