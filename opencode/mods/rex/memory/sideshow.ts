// A Sideshow in memory, for the viewer's tests: sessions with a title and
// posts, assets and flattened posts, all set by the test; with `down` set,
// nothing answers, as a server that is not running. Each ask of a session's
// posts is told to the test, so it can wait for the viewer's next look
// without a clock. Every address reads the same world.
import { Effect, Layer, Option, Ref } from "effect"
import { type Post, Sideshow, SideshowFailed, type SideshowServer } from "../service.ts"

/** What the memory server holds. */
export interface World {
  readonly down: boolean
  readonly mine: Option.Option<string>
  readonly sessions: ReadonlyMap<string, { readonly title: string; readonly posts: ReadonlyArray<Post> }>
  readonly assets: ReadonlyMap<string, Uint8Array>
  readonly flat: ReadonlyMap<string, string>
}

export const BASE = "http://sideshow.test"

/** An empty, running server. */
export const empty: World = { down: false, mine: Option.none(), sessions: new Map(), assets: new Map(), flat: new Map() }

/** The server over `world`, telling `asked` each session whose posts are asked for. */
export const layer = (world: Ref.Ref<World>, asked: (session: string) => Effect.Effect<unknown> = () => Effect.void) => {
  const failed = (message: string) => new SideshowFailed({ base: BASE, message })
  /** The world when the server is up. */
  const up = Effect.flatMap(Ref.get(world), (now) =>
    Option.match(Option.liftPredicate(now, (held) => !held.down), {
      onNone: () => Effect.fail(failed(`Sideshow not reachable at ${BASE}: ECONNREFUSED`)),
      onSome: Effect.succeed,
    }),
  )
  const found = <A>(value: Option.Option<A>, missing: string) =>
    Option.match(value, { onNone: () => Effect.fail(failed(`Sideshow at ${BASE} has no ${missing}`)), onSome: Effect.succeed })
  const at: SideshowServer = {
    title: (session) => Effect.map(up, (now) => Option.map(Option.fromUndefinedOr(now.sessions.get(session)), (held) => held.title)),
    posts: (session) => Effect.andThen(asked(session), Effect.flatMap(up, (now) => Effect.map(found(Option.fromUndefinedOr(now.sessions.get(session)), `session ${session}`), (held) => held.posts))),
    asset: (id) => Effect.flatMap(up, (now) => found(Option.fromUndefinedOr(now.assets.get(id)), `asset ${id}`)),
    markdown: (post) => Effect.flatMap(up, (now) => found(Option.fromUndefinedOr(now.flat.get(post)), `post ${post}`)),
  }
  return Layer.succeed(Sideshow, Sideshow.of({ base: BASE, mine: Effect.map(up, (now) => now.mine), at: () => at }))
}
