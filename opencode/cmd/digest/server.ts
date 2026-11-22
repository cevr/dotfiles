/**
 * The digest mod's server half: an OpenCode server plugin that owns this host's digest log
 * (`~/.local/state/opencode-digest/events-YYYY-MM.jsonl`) and answers its RPC (`DIGEST` in
 * `@dotfiles/opencode-digest/event`). Every other plugin that writes a fact (orchestrate, queue, questions)
 * sends its line here through `ctx.rpc(DIGEST).append({ line })`, behind `@dotfiles/opencode-digest/relay`.
 * A line that does not decode as an event, or is over MAX_LINE bytes, is refused: the log holds only lines a
 * reader can fold.
 *
 * It also serves the digest's page on http://127.0.0.1:8240, and on the host's tailnet addresses on the same port
 * while Tailscale runs (`@dotfiles/opencode-digest/http/listener`, re-read every RECHECK): the
 * built page, the view folded from the log and the owner's marks at each request (no model call, nothing
 * polled), and his marks (read, unread, Later, a project's name) kept beside the log (`filestore/marks`).
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `dir`: the log's directory, default `$XDG_STATE_HOME/opencode-digest` (`~/.local/state/opencode-digest`).
 * - `timezone` (digest.timezone): the zone Later's morning (6:00 AM) and the page's times are in, default the host's.
 * - `port`: the page's port, on 127.0.0.1 and the tailnet, default 8240.
 * - `tailnetRead` (digest.tailnetRead): who reads the page on the tailnet, `"paired"` (default: a browser paired with
 *   bun cmd/digest/pair.ts) or `"member"` (his own devices: those of this host's Tailscale user, never another
 *   user's device on a shared tailnet).
 * - `tailnetWrite` (digest.tailnetWrite): who marks and answers on the tailnet without pairing: `"paired"` (default),
 *   `"member"` (his own devices) or `"member-except-hosts"` (his own devices except this host and the agent hosts,
 *   which still need pairing, as loopback does for an answer).
 * - `agentHosts` (digest.agentHosts): the agent machines beside this one, by MagicDNS name, each keyed in the device
 *   store by `bun cmd/digest/devices.ts agent <name>` (its stable node IDs; devices.ts). It only narrows writes,
 *   never admits a device; a name the store does not key, or that no device of his answers to, closes the writes.
 * - `excludedDevices` (digest.excludedDevices): his devices that count as nobody's, reading and writing nothing
 *   unpaired, by MagicDNS name, each keyed by `bun cmd/digest/devices.ts exclude <name>`. A name the store does not
 *   key closes every tailnet source to "paired", reads and writes, until it is keyed.
 *   (members.ts: who his devices are, read again with the tailnet every RECHECK.)
 * - `name` (digest.name): this host as the page labels its projects, default `this host`.
 * - `peers` (digest.peers): the other hosts whose projects the page shows beside its own, `[{ name, host }]`: `host`
 *   is an agent host's name, found only as the device the device store keys for it (peers.ts). Default none. Their
 *   pages may write here cross-origin, tokenless, under this host's own policy (policy.ts, the tailnet listener only).
 *
 * `GET /health` answers the health line (`@dotfiles/opencode-digest/health`), which the installer logs.
 */
import { Plugin } from "@opencode/plugin/effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Cause, Clock, Context, Effect, Layer, Option, Path, Ref, Schema, type Scope } from "effect"
import { answer, AnswerOutcome, type Answerers, ItemReply, QuestionReply } from "@dotfiles/opencode-digest/answers"
import { AppendInput, byteLength, decodeLine, decodeLines, DIGEST, MAX_LINE } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import * as FileMarks from "@dotfiles/opencode-digest/filestore/marks"
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { EMPTY, fold } from "@dotfiles/opencode-digest/fold"
import { buildOf, healthLine, sickLine, type TailnetState } from "@dotfiles/opencode-digest/health"
import * as Listener from "@dotfiles/opencode-digest/http/listener"
import { noPeers, type PeerSide, peerSide, servePeers } from "@dotfiles/opencode-digest/http/peers"
import { envelopeOf, locateIn, mergeView, NamedPeer, type Peer, peerOriginsOf, type Sighting, UNSEEN, upCount } from "@dotfiles/opencode-digest/peers"
import * as LivePeers from "@dotfiles/opencode-digest/process/peers"
import { pageOf } from "@dotfiles/opencode-digest/messages"
import { type Copy, keysOf, membersWith, type Named } from "@dotfiles/opencode-digest/devices"
import * as FileDevices from "@dotfiles/opencode-digest/filestore/devices"
import { closed, type Members } from "@dotfiles/opencode-digest/members"
import { TAILNET_WRITES, type TailnetRead, type TailnetWrite } from "@dotfiles/opencode-digest/policy"
import * as Tailnet from "@dotfiles/opencode-digest/process/tailnet"
import { DigestLines, DigestUnwritable } from "@dotfiles/opencode-digest/service"
import { encodeView, viewOf } from "@dotfiles/opencode-digest/view"
import { hostZone, isZone } from "@dotfiles/opencode-digest/zone"
import { QUESTIONS } from "@dotfiles/opencode-questions/question"
import { QUEUE } from "@dotfiles/opencode-queue/queue"

/** The options; `dir` falls back to the host's state directory, read when the plugin starts. */
export const Options = Schema.Struct({
  dir: Schema.optionalKey(Schema.NonEmptyString),
  timezone: Schema.optionalKey(Schema.String.check(Schema.makeFilter((zone) => isZone(zone) || `"${zone}" is not a time zone`))),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))),
  tailnetRead: Schema.optionalKey(Schema.Literals(["paired", "member"])),
  name: Schema.optionalKey(Schema.NonEmptyString),
  peers: Schema.optionalKey(Schema.Array(NamedPeer)),
  tailnetWrite: Schema.optionalKey(Schema.Literals(TAILNET_WRITES)),
  agentHosts: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  excludedDevices: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
})
export type Options = typeof Options.Type

/** `digest.tailnetWrite`, and the names `digest.agentHosts` and `digest.excludedDevices` give the device store to key, each at its default when absent. */
export const writeConfigOf = (options: Options): WriteConfig => ({
  tailnetWrite: Option.getOrElse(Option.fromUndefinedOr(options.tailnetWrite), (): TailnetWrite => "paired"),
  agentHosts: Option.getOrElse(Option.fromUndefinedOr(options.agentHosts), (): ReadonlyArray<string> => []),
  excluded: Option.getOrElse(Option.fromUndefinedOr(options.excludedDevices), (): ReadonlyArray<string> => []),
})

/** What the plugin applies: the write switch, and the names the device store keys. */
export interface WriteConfig extends Named {
  readonly tailnetWrite: TailnetWrite
}

/** The device store's two copies for `options` (filestore/devices.ts): beside the log, and under the config tree. */
export const storePathsOf = (options: Options): readonly [string, string] => FileDevices.pathsOf(dirOf(options), TuiDirs.dirs().config)

/** His devices before the first tailnet read: none, so every tailnet source needs pairing. */
export const STARTING: Members = closed("starting")

/** The log's directory: the option, else the host's state directory's `opencode-digest`. */
export const dirOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.dir), () => `${TuiDirs.dirs().state}/opencode-digest`)

/** `digest.timezone`: the option, else the host's zone. */
export const zoneOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.timezone), hostZone)

/** The live log: the month files in the options' directory. */
export const live = (options: Options): Layer.Layer<DigestLines> => FileLog.layer(dirOf(options))

/** The built page, committed beside the digest mod (`mods/digest/page/dist`). */
const DIST = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("../../mods/digest/page/dist", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie)

/** The build this plugin runs from (its tree's name), `dev` from a checkout. */
const BUILD = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("./server.ts", import.meta.url))).pipe(Effect.map(buildOf), Effect.provide(Path.layer), Effect.orElseSucceed(() => "dev"))

/** The health line over the log `lines`: its events and the newest one's time, and what the tailnet listener does. */
export const healthOf = (lines: DigestLines["Service"], tailnet: Effect.Effect<TailnetState>, peers: Effect.Effect<ReadonlyArray<Peer>> = Effect.succeed([])): Effect.Effect<string> =>
  Effect.gen(function* () {
    const host = yield* Tailnet.hostName
    const build = yield* BUILD
    return yield* lines.read.pipe(
      Effect.flatMap((log) =>
        Effect.map(Effect.all([tailnet, peers]), ([served, known]) => {
          const events = decodeLines(log).events
          const last = Option.map(Option.fromUndefinedOr(events.at(-1)), (event) => event.t)
          return healthLine({ build, host, events: events.length, last, peers: { up: upCount(known), named: known.length }, tailnet: served })
        }),
      ),
      Effect.catch((failure) => Effect.succeed(sickLine(build, host, failure.message))),
    )
  })

/** `digest.name`: the option, else `this host`. */
export const nameOf = (options: Options): string => Option.getOrElse(Option.fromUndefinedOr(options.name), () => "this host")

/** `digest.peers`: the option, else none. */
export const namedOf = (options: Options): ReadonlyArray<NamedPeer> => Option.getOrElse(Option.fromUndefinedOr(options.peers), () => [])

/**
 * The page's handlers over the log `lines`, the marks and the pairing beside it, and the plugins that take answers;
 * `members`, his devices as last read; `peers`, the named peers as last read and located (http/peers.ts PeerSide).
 */
export const handlersOf = (
  options: Options,
  lines: DigestLines["Service"],
  answerers: Answerers,
  tailnet: Effect.Effect<TailnetState> = Effect.succeed("no:starting"),
  members: Effect.Effect<Members> = Effect.succeed(STARTING),
  peers: PeerSide = noPeers(namedOf(options)),
): Listener.Handlers => {
  const marks = FileMarks.make(dirOf(options))
  const zone = zoneOf(options)
  const state = Effect.map(lines.read, (log) => fold(EMPTY, decodeLines(log).events))
  const local = Effect.gen(function* () {
    const page = pageOf(yield* state, { names: new Map() })
    return viewOf(page, yield* marks.read, yield* Clock.currentTimeMillis, zone)
  })
  return {
    health: healthOf(lines, tailnet, peers.known),
    tailnetRead: Option.getOrElse(Option.fromUndefinedOr(options.tailnetRead), (): TailnetRead => "paired"),
    members,
    view: Effect.map(Effect.all([local, peers.known]), ([view, known]) => encodeView(mergeView(view, nameOf(options), known))),
    peerView: Effect.map(local, (view) => envelopeOf(nameOf(options), view)),
    peerOrigins: peers.origins,
    peerPages: Effect.map(peers.known, (known) => known.flatMap((peer) => Option.toArray(peer.origin))),
    write: marks.append,
    now: Clock.currentTimeMillis,
    zone,
    // A log that cannot be read is no answer to check against: the page is told why.
    answer: (input) =>
      answer(Effect.orDie(state), answerers, input).pipe(Effect.catchDefect((defect) => Effect.succeed(AnswerOutcome.Refused({ status: 500, reason: String(defect) })))),
    pairing: FilePairing.make(dirOf(options)),
  }
}

const decodeQuestionReply = Schema.decodeUnknownEffect(QuestionReply)
const decodeItemReply = Schema.decodeUnknownEffect(ItemReply)

/** What a plugin that takes answers answers when it is not there or answers nonsense. */
const unreachable = (what: string) => (failure: Cause.Cause<unknown>) => Effect.succeed({ ok: false, message: `the ${what} plugin did not take it: ${Cause.pretty(failure)}` })

/** The answers' owners over this host's RPC: the questions plugin (as from the page) and the queue. */
export const answerersOf = (ctx: Plugin.Context): Answerers => ({
  question: (session, id, given) =>
    ctx.rpc(QUESTIONS).answer({ sessionID: session, answers: [{ id, answer: given }], via: "page" }).pipe(Effect.flatMap(decodeQuestionReply), Effect.catchCause(unreachable("questions"))),
  item: (root, id, given) => ctx.rpc(QUEUE).answer({ sessionID: root, id, answer: given }).pipe(Effect.flatMap(decodeItemReply), Effect.catchCause(unreachable("queue"))),
})

/**
 * The tailnet as `probe` reads it, keeping his devices from the same status read in `members` each time, with the
 * device store's keys as `copies` reads them then (devices.ts keysOf): a read that fails, or a name the store does
 * not key, closes them at once. The same read and keys go to `sighted`, which finds the named peers (peers.ts).
 */
export const probeKeeping = (
  config: WriteConfig,
  probe: Effect.Effect<Tailnet.Probed>,
  members: Ref.Ref<Members>,
  copies: Effect.Effect<readonly [Copy, Copy]>,
  sighted: (sighting: Sighting) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<Tailnet.Probed["tailnet"]> =>
  Effect.gen(function* () {
    const read = yield* probe
    const [primary, secondary] = yield* copies
    const keys = keysOf(config, primary, secondary)
    const at = yield* Clock.currentTimeMillis
    yield* Ref.set(members, membersWith(config.tailnetWrite, keys, read.status, at))
    yield* sighted({ read: read.status, agents: keys.agents, excluded: keys.excluded, at })
    return read.tailnet
  })

/** The page's port: the option, else PORT. */
export const portOf = (options: Options): number => Option.getOrElse(Option.fromUndefinedOr(options.port), () => Listener.PORT)

/** The named peers, each found as `sighting` last keyed it (peers.ts locateIn) and read over the tailnet; their pages' origins as it keys them. */
export const livePeers = (options: Options, sighting: Ref.Ref<Sighting>): Effect.Effect<PeerSide> =>
  peerSide(
    namedOf(options),
    Effect.map(Effect.all([Ref.get(sighting), Clock.currentTimeMillis]), ([seen, now]) => locateIn(namedOf(options), seen, now, portOf(options))),
    LivePeers.get,
    Clock.currentTimeMillis,
    Effect.map(Effect.all([Ref.get(sighting), Clock.currentTimeMillis]), ([seen, now]) => peerOriginsOf(namedOf(options), seen, now, portOf(options))),
  )

/**
 * The live page: the listener on 127.0.0.1 and those on the host's tailnet addresses, with `handlers`, each retrying
 * while another instance holds it; `tailnet` is what the tailnet's listeners do, for the health line, and `members`
 * his devices from the same reads, and `sighting` what finds the peers; `peers` are read every PULL_EVERY
 * (http/peers.ts).
 */
export const livePage = (
  options: Options,
  handlers: Listener.Handlers,
  tailnet: Ref.Ref<TailnetState>,
  members: Ref.Ref<Members>,
  peers: PeerSide = noPeers([]),
  sighting: Ref.Ref<Sighting> = Ref.makeUnsafe(UNSEEN),
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dist = yield* DIST
    const port = portOf(options)
    yield* Effect.forkScoped(Listener.serveTailnet(port, handlers, dist, probeKeeping(writeConfigOf(options), Tailnet.probeWithStatus, members, FileDevices.readCopies(storePathsOf(options)), (seen) => Ref.set(sighting, seen)), tailnet))
    if (namedOf(options).length > 0) yield* Effect.forkScoped(servePeers(peers.pull))
    yield* Listener.serve(port, handlers, dist)
  })

const decodeInput = Schema.decodeUnknownEffect(AppendInput)

/** A malformed option: the plugin does not start. */
class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("InvalidOptions", { message: Schema.String }) {}

/** One line the RPC was given (`input`, as decoded), checked: it must decode as an event and fit MAX_LINE. */
const checked = (input: Effect.Effect<AppendInput, Schema.SchemaError>) =>
  input.pipe(
    Effect.mapError(() => new DigestUnwritable({ message: "append takes { line: string }" })),
    Effect.flatMap(({ line }) =>
      Option.match(Option.filter(decodeLine(line), () => byteLength(line) <= MAX_LINE && !line.includes("\n")), {
        onNone: () => Effect.fail(new DigestUnwritable({ message: "the line is not one digest event of at most 4,096 bytes" })),
        onSome: (event) => Effect.succeed({ line, t: event.t }),
      }),
    ),
  )

/** A page that serves nothing: the seam test's and the simulations', which never bind a port. */
const noPage = (): Effect.Effect<void, never, Scope.Scope> => Effect.void

/**
 * The plugin on `externals` and `page`: the file log and the live page in OpenCode, the memory log and no page in
 * the seam test and the simulations.
 */
export const make = (externals: (options: Options) => Layer.Layer<DigestLines>, page: typeof livePage = noPage) =>
  Plugin.define({
    id: "dotfiles-opencode.digest",
    effect: Effect.fn("Digest.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new InvalidOptions({ message: `dotfiles-opencode.digest: invalid options: ${error.message}` })),
        Effect.orDie,
      )
      const lines = Context.get(yield* Layer.build(externals(options)), DigestLines)
      // A refused line is answered as refused, so the writer's relay drops it; a line that cannot be written fails
      // the call, so the relay holds it and tries again.
      yield* ctx.rpc
        .register(DIGEST, {
          append: (input) =>
            Effect.matchEffect(checked(decodeInput(input)), {
              onFailure: (refused) => Effect.as(Effect.logWarning("digest: a line was refused", { reason: refused.message }), { refused: refused.message }),
              onSuccess: ({ line, t }) =>
                lines.append(line, t).pipe(
                  Effect.tapError((failure) => Effect.logWarning("digest: a line was not written", { reason: failure.message })),
                  Effect.as({}),
                  Effect.orDie,
                ),
            }),
        })
        .pipe(Effect.orDie)
      const tailnet = yield* Ref.make<TailnetState>("no:starting")
      const members = yield* Ref.make(STARTING)
      const sighting = yield* Ref.make(UNSEEN)
      const peers = yield* livePeers(options, sighting)
      yield* Effect.forkScoped(page(options, handlersOf(options, lines, answerersOf(ctx), Ref.get(tailnet), Ref.get(members), peers), tailnet, members, peers, sighting))
    }),
  })

export default make(live, livePage)
