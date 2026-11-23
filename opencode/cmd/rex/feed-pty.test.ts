// @reads all
// @reads-reason subprocess reads at cmd/rex/feed-pty.test.ts: return Bun.spawn([process.execPath, SHOW, "view", "--session", "session:pty", "--spool", root],
// The feed as its pane runs it: `rex-show view` in a real terminal (a pty
// from Bun.spawn's `terminal`, the child in its own process group, killed
// when the case ends), its spool showing a feed of a stand-in Sideshow (a
// Bun.serve on a free local port) whose posts the case adds and revises over
// time. The case reads what the pane draws, its styles dropped, and types
// into it as its user: a post that comes shows on top of the timeline (no dot,
// as the view follows it), the board shows its newest version, cut at a third
// of the pane with what is past it said and `B` then `j` scrolling it, `j`
// then `[` walk a post's versions back, a tally an agent writes to the
// spool mid-comment shows in the header and keeps all of that and the
// half-typed comment (the pane goes on, it does not start again), `c` sends
// a comment Sideshow hears as the user's, and `q`
// ends the program with exit 0.
import { describe, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Feed, Spooled } from "@dotfiles/opencode-rex/spool"
import { Array as Arr, Duration, Effect, Option, Queue, Schema } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"

const encodeSpooled = Schema.encodeSync(Schema.fromJsonString(Spooled))

const SHOW = fileURLToPath(new URL("./show.ts", import.meta.url))
const STYLE = new RegExp(String.raw`\u001b(\[[0-9;?<>]*[ -/]*[@-~]|\][^\u0007\u001b]*(\u0007|\u001b\\)|_[^\u001b]*\u001b\\|[()][A-Z0-9]|[=>78])`, "g")

const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`
const markdown = (text: string) => [{ kind: "markdown", index: 0, markdown: text }]
const boardPost = (version: number, step: string) => ({ id: "b", sessionId: "s1", title: "Board", version, createdAt: at(0), updatedAt: at(version), surfaces: markdown(`# Shipping the feed\n\n- ${step}`) })
const notes = { id: "n", sessionId: "s1", title: "notes", version: 3, createdAt: at(1), updatedAt: at(3), surfaces: markdown("# Notes\n\nthird draft") }
const sketch = { id: "k", sessionId: "s1", title: "sketch", version: 1, createdAt: at(5), updatedAt: at(5), surfaces: markdown("# Sketch\n\nnew idea") }
/** The versions Sideshow kept of each post before its current one. */
const HISTORY = new Map([
  [
    "n",
    [
      { version: 1, title: "notes", at: at(1), surfaces: markdown("# Notes\n\nfirst draft") },
      { version: 2, title: "notes", at: at(2), surfaces: markdown("# Notes\n\nsecond draft") },
    ],
  ],
])

/** The stand-in Sideshow: session s1, titled Plan, holding `posts`, and every comment it heard with whether it came as the viewer's page sends one. */
interface Stage {
  posts: ReadonlyArray<typeof notes>
  readonly comments: Array<{ readonly body: unknown; readonly sameOrigin: boolean }>
}

const serve = (stage: Stage) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          if (path === "/api/sessions") return Response.json([{ id: "s1", title: "Plan", lastActiveAt: at(5) }])
          if (path === "/api/sessions/s1/posts") return Response.json(stage.posts)
          if (path === "/api/comments" && request.method === "POST") {
            const sameOrigin = request.headers.get("sec-fetch-site") === "same-origin"
            stage.comments.push({ body: await request.json(), sameOrigin })
            return Response.json({ id: "c1" })
          }
          return Option.match(Arr.findFirst(stage.posts, (each) => path === `/api/posts/${each.id}`), {
            onNone: () => new Response("no", { status: 404 }),
            onSome: (post) => Response.json({ ...post, history: Option.getOrElse(Option.fromUndefinedOr(HISTORY.get(post.id)), () => []) }),
          })
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )

/** A scratch folder, removed when the case ends. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "rex-feed-pty-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** `rex-show view` for session:pty in a 120 × 40 pty, its own process group, its output chunks to `out`; the group killed when the case ends. */
const pane = (root: string, base: string, out: Queue.Queue<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const decoder = new TextDecoder()
      return Bun.spawn([process.execPath, SHOW, "view", "--session", "session:pty", "--spool", root], {
        detached: true,
        env: { ...process.env, SIDESHOW_URL: base, SIDESHOW_SESSION: "s1", XDG_STATE_HOME: join(root, "state"), REX_SESSION: "", REX_BLOCK: "" },
        terminal: { cols: 120, rows: 40, data: (_terminal, data) => void Queue.offerUnsafe(out, decoder.decode(data, { stream: true })) },
      })
    }),
    (child) =>
      Effect.sync(() => {
        if (Option.isSome(Option.fromNullishOr(child.exitCode))) return
        process.kill(-child.pid, "SIGKILL")
      }),
  )

/** Read the pane until what it drew since the last call holds every one of `wanted` (styles dropped); fails after 10 s. */
const drawn = (out: Queue.Queue<string>, seen: { text: string }, ...wanted: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // Styles dropped from all read so far, as a chunk can end inside one.
    const plain = () => seen.text.replace(STYLE, "")
    while (!wanted.every((text) => plain().includes(text))) seen.text += yield* Queue.take(out)
    const frame = plain()
    seen.text = ""
    return frame
  }).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.fail(`the pane never drew ${wanted.join(" … ")}; it drew: ${seen.text.slice(-600)}`) }))

describe("the feed in a terminal", () => {
  effectTest(
    "a post that comes shows on top, the board shows its newest version, [ walks versions, c sends the user's comment, q ends it",
    Effect.scoped(
      Effect.gen(function* () {
        const stage: Stage = { posts: [boardPost(1, "step one"), notes], comments: [] }
        const server = yield* serve(stage)
        const root = yield* scratch
        const base = `http://127.0.0.1:${server.port}`
        mkdirSync(join(root, "session_pty"), { recursive: true })
        writeFileSync(join(root, "session_pty", "spool.json"), encodeSpooled({ seq: 1, shown: Feed.make({ base, session: "s1", name: "s1", every: 1 }) }))
        const out = yield* Queue.unbounded<string>()
        const child = yield* pane(root, base, out)
        const seen = { text: "" }
        const type = (text: string) => Effect.sync(() => child.terminal?.write(text))

        yield* drawn(out, seen, "feed · Plan", "Board", "step one", "notes", "third draft")
        stage.posts = [boardPost(1, "step one"), notes, sketch]
        // The view follows the post that came, so it is seen: no dot.
        const came = yield* drawn(out, seen, "Timeline · 2", "¶ sketch", "new idea")
        const timeline = came.slice(came.lastIndexOf("Timeline · 2"))
        expect(timeline.indexOf("sketch")).toBeLessThan(timeline.indexOf("notes"))
        expect(timeline).not.toContain("●")
        // A long board: cut at a third of the pane, saying what is past it; B then j scrolls it, ← goes back.
        stage.posts = [boardPost(2, ["step two", ...Array.from({ length: 24 }, (_, at) => `done ${at + 1}`)].join("\n- ")), notes, sketch]
        const long = yield* drawn(out, seen, "v2", "step two", "more lines (B then j/k scrolls")
        const more = Number(/… (\d+) more lines/.exec(long.slice(long.lastIndexOf("v2 · updated")))?.[1] ?? "0")
        expect(more).toBeGreaterThan(0)
        yield* type("B")
        yield* drawn(out, seen, "board: j/k scroll")
        yield* type("j")
        yield* drawn(out, seen, `… ${more - 1} more lines`)
        yield* type("\u001b[D")
        yield* drawn(out, seen, "j/k move")
        yield* type("j")
        yield* drawn(out, seen, "v3/3", "third draft")
        yield* type("[")
        yield* drawn(out, seen, "v2/3", "second draft")
        yield* type("c")
        yield* type("looks good")
        yield* drawn(out, seen, "comment:", "looks good")
        // An agent's tally mid-comment, written as `rex-show tally` writes it: the feed goes on in place, its
        // tally in the header, the comment half typed, the pick, its version and the board's scroll all kept.
        writeFileSync(
          join(root, "session_pty", "spool.json"),
          encodeSpooled({ seq: 2, shown: Feed.make({ base, session: "s1", name: "s1", every: 1 }), tally: { msg: "3 of 7 checks green", state: "working", progress: 43 } }),
        )
        const tallied = { text: yield* drawn(out, seen, "◆ 3 of 7 checks green · 43%") }
        const latest = () => tallied.text.slice(tallied.text.lastIndexOf("feed · Plan"))
        while (!latest().includes("esc drops")) tallied.text += yield* drawn(out, seen, "esc drops")
        for (const kept of ["◆ 3 of 7 checks green · 43%", "comment: looks good", "notes · v2/3", "second draft", `… ${more - 1} more lines`]) {
          expect({ kept, drawn: latest().includes(kept) }).toEqual({ kept, drawn: true })
        }
        yield* type("\r")
        yield* drawn(out, seen, "comment sent")
        expect(stage.comments).toEqual([{ body: { surface: "n", text: "looks good", author: "user" }, sameOrigin: true }])
        yield* type("q")
        expect(yield* Effect.promise(() => child.exited)).toBe(0)
      }),
    ),
    30_000,
  )
})
