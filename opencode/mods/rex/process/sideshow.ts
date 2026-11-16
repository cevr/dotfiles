// Sideshow over HTTP, as the Sideshow: it reads sessions and posts, and
// writes only what the feed pane's user does (a comment) and what the pane
// records (an entry for a live view, with its shot). The CLI's server is
// `$SIDESHOW_URL` (else localhost:8228, the server on this host), and
// `$SIDESHOW_TOKEN` goes to it alone as a bearer token when set (never
// written anywhere). The caller's own session is found the way the
// `sideshow` CLI finds it, so `rex-show sideshow` run from an agent's shell
// follows what that agent publishes: `$SIDESHOW_SESSION`, else the CLI's
// state file for the agent process and folder (when the server still knows
// its session), else the session last active in this folder.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { byCwd, SessionRow } from "../feed.ts"
import { Post, PostDetail, Sideshow, SideshowFailed, type SideshowServer } from "../service.ts"

/** How long one request may take. */
const ASK_MS = 5_000

/** The shells the `sideshow` CLI walks past to find the agent process. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"])

/** Where the CLI's server is and who is asking: the caller's agent process and folder, and the CLI's state folder. */
export interface Places {
  readonly base: string
  readonly token: Option.Option<string>
  readonly session: Option.Option<string>
  readonly agent: number
  readonly cwd: string
  readonly stateDir: string
}

/** A process's parent and command name, by `ps`; none when `ps` does not know it. */
const parentOf = (pid: number): Option.Option<{ readonly ppid: number; readonly comm: string }> => {
  const out = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim()
  return Option.map(Option.fromNullishOr(/^\s*(\d+)\s+(.*)$/.exec(out)), (match) => ({ ppid: Number(match[1]), comm: match[2].trim() }))
}

const isShell = (comm: string) => SHELLS.has(Option.getOrElse(Arr.last(comm.split("/")), () => "").replace(/^-/, ""))

/** The agent process at or above `start` (this process's parent), past at most ten shells, as the `sideshow` CLI keys its state. */
export const agentOf = (start: number): number => {
  const walk = (pid: number, hops: number): number =>
    Option.match(
      Option.filter(parentOf(pid), (parent) => hops < 10 && isShell(parent.comm) && parent.ppid > 1),
      { onNone: () => pid, onSome: (parent) => walk(parent.ppid, hops + 1) },
    )
  return walk(start, 0)
}

/** The CLI's state file for `agent` in `cwd`. */
export const stateFile = (stateDir: string, agent: number, cwd: string) =>
  join(stateDir, `${createHash("sha1").update(`${agent}:${cwd}`).digest("hex").slice(0, 12)}.json`)

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ session: Schema.String })))
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
const decodePosts = Schema.decodeUnknownEffect(Schema.Array(Post))
const decodeDetail = Schema.decodeUnknownEffect(PostDetail)
const decodeMade = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ id: Schema.String })))

/** A failed request's error code, as Bun's fetch gives it. */
const decodeCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))
const why = (cause: unknown) => Option.match(decodeCode(cause), { onNone: () => String(cause), onSome: (failure) => failure.code })

/** `base` without a trailing slash. */
const trimmed = (base: string) => base.replace(/\/+$/, "")

/** The server at `address`, sent `token` as a bearer token when there is one. */
const server = (address: string, token: Option.Option<string>) => {
  const base = trimmed(address)
  const failed = (message: string) => new SideshowFailed({ base, message })
  const headers = Option.match(token, { onNone: () => ({}), onSome: (value) => ({ authorization: `Bearer ${value}` }) })
  /** The answer to GET `path`; a 404 is none. */
  const ask = Effect.fn("ProcessSideshow.ask")(function* (path: string) {
    const answer = yield* Effect.tryPromise({
      try: () => fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(ASK_MS) }),
      catch: (cause) => failed(`Sideshow not reachable at ${base}: ${why(cause)}`),
    })
    if (answer.status === 404) return Option.none<Response>()
    if (!answer.ok) return yield* failed(`Sideshow at ${base} answered ${answer.status} to ${path}`)
    return Option.some(answer)
  })
  /** The answer to GET `path`, or a failure naming `missing` when the server has none. */
  const must = (path: string, missing: string) =>
    Effect.flatMap(ask(path), (answer) => Option.match(answer, { onNone: () => Effect.fail(failed(`Sideshow at ${base} has no ${missing}`)), onSome: Effect.succeed }))
  const json = (path: string, missing: string) =>
    Effect.flatMap(must(path, missing), (answer) => Effect.tryPromise({ try: () => answer.json(), catch: () => failed(`Sideshow at ${base} sent no JSON for ${path}`) }))
  const sessions = Effect.flatMap(json("/api/sessions", "session list"), (rows) =>
    decodeSessions(rows).pipe(Effect.mapError(() => failed(`Sideshow at ${base} listed sessions in a shape rex-show does not know`))),
  )
  const known = (session: string) => Effect.map(ask(`/api/sessions/${encodeURIComponent(session)}/posts`), Option.isSome)
  /** The JSON answer to POST `path` with `body`, as `extra` headers say; any status but a 2xx fails with the server's words. */
  const send = Effect.fn("ProcessSideshow.send")(function* (path: string, body: BodyInit, extra: Readonly<Record<string, string>>) {
    const answer = yield* Effect.tryPromise({
      try: () => fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(ASK_MS) }),
      catch: (cause) => failed(`Sideshow not reachable at ${base}: ${why(cause)}`),
    })
    const text = yield* Effect.tryPromise({ try: () => answer.text(), catch: (cause) => failed(`${path}: ${why(cause)}`) })
    if (!answer.ok) return yield* failed(`Sideshow at ${base} answered ${answer.status} to ${path}: ${text.slice(0, 200)}`)
    return text
  })
  const madeId = (path: string) => (text: string) => decodeMade(text).pipe(Effect.map((made) => made.id), Effect.mapError(() => failed(`Sideshow at ${base} answered ${path} without an id`)))
  const JSON_BODY = { "content-type": "application/json" }
  const at: SideshowServer = {
    title: (session) => Effect.map(sessions, (rows) => Option.flatMap(Arr.findFirst(rows, (row) => row.id === session), (row) => Option.fromNullishOr(row.title))),
    posts: (session) =>
      Effect.flatMap(json(`/api/sessions/${encodeURIComponent(session)}/posts`, `session ${session}`), (rows) =>
        decodePosts(rows).pipe(Effect.mapError(() => failed(`Sideshow at ${base} listed posts in a shape rex-show does not know`))),
      ),
    post: (id) =>
      Effect.flatMap(json(`/api/posts/${encodeURIComponent(id)}`, `post ${id}`), (row) =>
        decodeDetail(row).pipe(Effect.mapError(() => failed(`Sideshow at ${base} sent post ${id} in a shape rex-show does not know`))),
      ),
    // The user's label is the viewer's alone: Sideshow gives it to a same-origin request, as its own page sends one.
    comment: (post, text) => Effect.asVoid(send("/api/comments", JSON.stringify({ surface: post, text, author: "user" }), { ...JSON_BODY, "sec-fetch-site": "same-origin" })),
    upload: (session, png) =>
      Effect.flatMap(send(`/api/assets?session=${encodeURIComponent(session)}&filename=shot.png&kind=image`, new Blob([new Uint8Array(png)]), { "content-type": "image/png" }), madeId("/api/assets")),
    publish: (entry) => Effect.flatMap(send("/api/posts", JSON.stringify(entry), JSON_BODY), madeId("/api/posts")),
    asset: (id) =>
      Effect.flatMap(must(`/a/${encodeURIComponent(id)}`, `asset ${id}`), (answer) =>
        Effect.map(Effect.tryPromise({ try: () => answer.arrayBuffer(), catch: (cause) => failed(`asset ${id}: ${why(cause)}`) }), (buffer) => new Uint8Array(buffer)),
      ),
    markdown: (post) =>
      Effect.flatMap(must(`/api/posts/${encodeURIComponent(post)}/markdown`, `post ${post}`), (answer) =>
        Effect.tryPromise({ try: () => answer.text(), catch: (cause) => failed(`post ${post}: ${why(cause)}`) }),
      ),
  }
  return { base, known, sessions, at }
}

/** The Sideshow `places` describe. */
export const layer = (places: Places) =>
  Layer.sync(Sideshow, () => {
    const own = server(places.base, places.token)
    /** The session the CLI's state file names for the caller's agent and folder, if any. */
    const fromState = Effect.sync(() =>
      Option.map(
        decodeState(Option.getOrElse(Option.liftThrowable(() => readFileSync(stateFile(places.stateDir, places.agent, places.cwd), "utf8"))(), () => "")),
        (state) => state.session,
      ),
    )
    const mine = Effect.gen(function* () {
      if (Option.isSome(places.session)) return places.session
      const kept = yield* fromState
      if (Option.isSome(kept) && (yield* own.known(kept.value))) return kept
      return byCwd(yield* own.sessions, places.cwd)
    })
    return Sideshow.of({
      base: own.base,
      mine,
      at: (address) =>
        Option.match(Option.liftPredicate(trimmed(address), (wanted) => wanted === own.base), {
          onSome: () => own.at,
          onNone: () => server(address, Option.none()).at,
        }),
    })
  })
