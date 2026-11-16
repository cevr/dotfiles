// A Sideshow in memory, for the viewer's tests: sessions with a title and
// posts, posts' earlier versions, assets and flattened posts, all set by the
// test; the comments, uploads and posts the viewer sends are kept for the
// test to read (a post it publishes joins its session). With `down` set,
// nothing answers, as a server that is not running. Each ask of a session's
// posts is told to the test, so it can wait for the viewer's next look
// without a clock. Every address reads the same world.
import { Effect, Layer, Option, Ref } from "effect"
import { type Entry, type Post, Sideshow, SideshowFailed, type SideshowServer, type Version } from "../service.ts"

/** What the memory server holds. */
export interface World {
  readonly down: boolean
  readonly mine: Option.Option<string>
  readonly sessions: ReadonlyMap<string, { readonly title: string; readonly posts: ReadonlyArray<Post> }>
  readonly history: ReadonlyMap<string, ReadonlyArray<Version>>
  readonly assets: ReadonlyMap<string, Uint8Array>
  readonly flat: ReadonlyMap<string, string>
  readonly comments: ReadonlyArray<{ readonly post: string; readonly text: string }>
  readonly entries: ReadonlyArray<Entry>
}

export const BASE = "http://sideshow.test"

/** An empty, running server. */
export const empty: World = { down: false, mine: Option.none(), sessions: new Map(), history: new Map(), assets: new Map(), flat: new Map(), comments: [], entries: [] }

/** The time the memory server stamps on what it is sent. */
const STAMP = "2026-11-16T00:00:00.000Z"

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
  const allPosts = (now: World) => [...now.sessions.values()].flatMap((held) => held.posts)
  const at: SideshowServer = {
    title: (session) => Effect.map(up, (now) => Option.map(Option.fromUndefinedOr(now.sessions.get(session)), (held) => held.title)),
    posts: (session) => Effect.andThen(asked(session), Effect.flatMap(up, (now) => Effect.map(found(Option.fromUndefinedOr(now.sessions.get(session)), `session ${session}`), (held) => held.posts))),
    post: (id) =>
      Effect.flatMap(up, (now) =>
        Effect.map(found(Option.fromNullishOr(allPosts(now).find((post) => post.id === id)), `post ${id}`), (post) => ({
          ...post,
          history: Option.getOrElse(Option.fromUndefinedOr(now.history.get(id)), () => []),
        })),
      ),
    asset: (id) => Effect.flatMap(up, (now) => found(Option.fromUndefinedOr(now.assets.get(id)), `asset ${id}`)),
    markdown: (post) => Effect.flatMap(up, (now) => found(Option.fromUndefinedOr(now.flat.get(post)), `post ${post}`)),
    comment: (post, text) =>
      Effect.flatMap(up, (now) =>
        Effect.flatMap(found(Option.fromNullishOr(allPosts(now).find((each) => each.id === post)), `post ${post}`), () =>
          Ref.update(world, (held) => ({ ...held, comments: [...held.comments, { post, text }] })),
        ),
      ),
    upload: (_session, png) =>
      Effect.flatMap(up, (now) => {
        const id = `asset-${now.assets.size + 1}`
        return Effect.as(Ref.update(world, (held) => ({ ...held, assets: new Map([...held.assets, [id, png]]) })), id)
      }),
    publish: (entry) =>
      Effect.flatMap(up, (now) => {
        const id = `entry-${now.entries.length + 1}`
        const post: Post = {
          id,
          title: entry.title,
          version: 1,
          createdAt: STAMP,
          updatedAt: STAMP,
          surfaces: entry.surfaces.map((surface, index) => ({ kind: Option.getOrElse(Option.fromUndefinedOr(surface.kind), () => "html"), index, ...surface })),
        }
        return Effect.as(
          Ref.update(world, (held) => {
            const session = Option.getOrElse(Option.fromUndefinedOr(held.sessions.get(entry.session)), () => ({ title: entry.session, posts: [] }))
            return { ...held, entries: [...held.entries, entry], sessions: new Map([...held.sessions, [entry.session, { ...session, posts: [...session.posts, post] }]]) }
          }),
          id,
        )
      }),
  }
  return Layer.succeed(Sideshow, Sideshow.of({ base: BASE, mine: Effect.map(up, (now) => now.mine), at: () => at }))
}
