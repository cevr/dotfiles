// Reading the named peers (peers.ts): all of them once every PULL_EVERY, one at a time, each read at most
// PEER_TIMEOUT and never retried within a pull. What was read is kept in a Ref the page's view and the health line
// read without waiting: a slow or dead peer never holds a local request up.
import { Duration, Effect, Option, Ref } from "effect"
import { afterReading, type NamedPeer, PEER_TIMEOUT, type Peer, PULL_EVERY, Reading, readingOf, type Target, unread } from "../peers.ts"

/** What one GET answered: its status and body. */
export interface Got {
  readonly status: number
  readonly body: string
}

/** Every named peer, never read yet. */
export const unreadAll = (named: ReadonlyArray<NamedPeer>): ReadonlyArray<Peer> => named.map((each) => unread(each.name))

/** One read of `target` with `get`, as a reading: never fails, never past `timeout`. */
export const readOne = (get: (url: string) => Effect.Effect<Got, unknown>, target: Target, timeout: Duration.Duration = PEER_TIMEOUT): Effect.Effect<Reading> =>
  get(`${target.base}/peer/view.json`).pipe(
    Effect.timeoutOption(timeout),
    Effect.map((got) =>
      Option.match(got, {
        onNone: () => Reading.Down({ reason: `no answer in ${Duration.toSeconds(timeout)} s` }),
        onSome: (answer) => readingOf(answer.status, answer.body),
      }),
    ),
    Effect.orElseSucceed(() => Reading.Down({ reason: "unreachable" })),
  )

/**
 * One pull: locate the peers of `named` (by name; one not located is down, "not on the tailnet now"), read each in
 * turn with `get`, and keep each reading in `peers` as it comes, at the time `now` says.
 */
export const pull = (
  named: ReadonlyArray<NamedPeer>,
  locate: Effect.Effect<ReadonlyMap<string, Target>>,
  get: (url: string) => Effect.Effect<Got, unknown>,
  peers: Ref.Ref<ReadonlyArray<Peer>>,
  now: Effect.Effect<number>,
  timeout: Duration.Duration = PEER_TIMEOUT,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const located = yield* locate
    for (const each of named) {
      const target = Option.fromUndefinedOr(located.get(each.name))
      const reading = yield* Option.match(target, { onNone: () => Effect.succeed(Reading.Down({ reason: "not on the tailnet now" })), onSome: (found) => readOne(get, found, timeout) })
      const at = yield* now
      yield* Ref.update(peers, (all) =>
        all.map((peer) => Option.getOrElse(Option.map(Option.liftPredicate(peer, (one) => one.name === each.name), (one) => afterReading(one, reading, Option.map(target, (found) => found.base), at)), () => peer)),
      )
    }
  })

/**
 * The named peers as the page sees them (`known`, as last read), one pull of them all, which keeps what it reads, and
 * their pages' origins as this host keys them now (`origins`, peers.ts peerOriginsOf): the only ones it lets write here.
 */
export interface PeerSide {
  readonly known: Effect.Effect<ReadonlyArray<Peer>>
  readonly pull: Effect.Effect<void>
  readonly origins: Effect.Effect<ReadonlyArray<string>>
}

/** The peers of `named` never read, and no pull: a host with no peers, a test's, a simulation's. */
export const noPeers = (named: ReadonlyArray<NamedPeer>): PeerSide => ({ known: Effect.succeed(unreadAll(named)), pull: Effect.void, origins: Effect.succeed([]) })

/** The peers of `named` read into a Ref of their own: `known` reads it, `pull` (the arguments of `pull`) fills it; `origins` as given. */
export const peerSide = (
  named: ReadonlyArray<NamedPeer>,
  locate: Effect.Effect<ReadonlyMap<string, Target>>,
  get: (url: string) => Effect.Effect<Got, unknown>,
  now: Effect.Effect<number>,
  origins: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([]),
): Effect.Effect<PeerSide> =>
  Effect.map(Ref.make(unreadAll(named)), (peers) => ({ known: Ref.get(peers), pull: pull(named, locate, get, peers, now), origins }))

/** A pull every `every`, until the scope closes. */
export const servePeers = (pullOnce: Effect.Effect<void>, every: Duration.Duration = PULL_EVERY): Effect.Effect<never> => Effect.forever(Effect.andThen(pullOnce, Effect.sleep(every)))
