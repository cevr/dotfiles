// The Host's queue read (tui/host.ts `queue`): the root session's queue over
// the queue mod's RPC, read as reading.ts reads a session (at once and every
// 2 seconds, the last reading kept when a read fails, one at the revision
// already read kept as it was), with the live state of the root's subagents
// from the TUI's data for the items linked to one. A reading that decodes
// says a queue plugin serves this OpenCode (`served`).
import { liveStates } from "@dotfiles/opencode-queue/opencode/subagents"
import { QUEUE, Snapshot } from "@dotfiles/opencode-queue/queue"
import type { FamilyReader } from "@dotfiles/opencode-subagents/solid/reader"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createMemo, createSignal, type Accessor } from "solid-js"
import type { QueueReading } from "../tui/host.ts"
import { readSession } from "./reading.ts"

const decode = Schema.decodeUnknownOption(Snapshot)

/** The answer last read, and for which root. */
interface Last {
  readonly root: string
  readonly answer: Option.Option<Snapshot>
}

/** The answer last read when it is for `root` at `snapshot`'s revision, else `snapshot`'s own. */
const kept = (last: Option.Option<Last>, root: string, snapshot: Snapshot): Option.Option<Snapshot> =>
  Option.getOrElse(
    Option.map(
      Option.filter(last, (each) => each.root === root && Option.exists(each.answer, (previous) => previous.revision === snapshot.revision)),
      (each) => each.answer,
    ),
    () => Option.some(snapshot),
  )

/** The queue reads of one TUI: `read` for a component, `served` once any reading decoded. */
export function queues(context: Plugin.Context, family: FamilyReader) {
  const [served, setServed] = createSignal(false)
  const read = (sessionID: Accessor<Option.Option<string>>): Accessor<Option.Option<QueueReading>> => {
    // The root's id as text, so a reading starts again only when it changes.
    const rootID = createMemo(() => Option.getOrElse(Option.map(sessionID(), (id) => context.data.session.root(id)), () => ""))
    const root = () => Option.liftPredicate(rootID(), (id) => id !== "")
    // A reading at the revision already read hands back the same value, so nothing draws again.
    let last = Option.none<Last>()
    const keep = (root: string, snapshot: Snapshot): Option.Option<Snapshot> => {
      const answer = kept(last, root, snapshot)
      last = Option.some({ root, answer })
      setServed(true)
      return answer
    }
    const snapshot = readSession(context, root, (id, signal) =>
      context.client
        .rpc(QUEUE)
        .get({ sessionID: id }, { location: context.location, signal })
        .then(decode, () => Option.none<Snapshot>())
        .then(Option.flatMap((answer) => keep(id, answer))),
    )
    return createMemo(() =>
      Option.flatMap(snapshot(), (shown) =>
        Option.map(root(), (id) => ({ root: id, items: shown.items, live: liveStates(context.data, id, context.location, family) })),
      ),
    )
  }
  return { read, served }
}
