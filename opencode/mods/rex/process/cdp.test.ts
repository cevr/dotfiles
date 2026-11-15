// The DevTools client against a stand-in debugger (a WebSocket served
// here): commands answered in order and an error answer failing; a frame
// acknowledged and only the newest kept; the main frame's navigations
// named, a child frame's not; and every wait failing once the socket closes.
import { describe, expect } from "bun:test"
import { Effect, Exit, Queue } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import type { Json } from "../service.ts"
import { connect } from "./cdp.ts"

/** A stand-in debugger: what it was sent, and a way to push events or close, for as long as the scope lasts. */
const debuggerStandIn = Effect.gen(function* () {
  const heard = yield* Queue.unbounded<{ readonly id: number; readonly method: string; readonly params: unknown }>()
  const peers: Array<Bun.ServerWebSocket<unknown>> = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request, serving) => {
          if (serving.upgrade(request)) return new Response()
          return new Response("no", { status: 400 })
        },
        websocket: {
          open: (peer) => void peers.push(peer),
          message: (peer, text) => {
            const message = JSON.parse(String(text))
            Queue.offerUnsafe(heard, message)
            if (message.method === "Page.screencastFrameAck") return
            if (message.method === "Bad.method") return void peer.send(JSON.stringify({ id: message.id, error: { message: "'Bad.method' wasn't found" } }))
            if (message.method === "Runtime.evaluate") return void peer.send(JSON.stringify({ id: message.id, result: { result: { type: "boolean", value: true } } }))
            peer.send(JSON.stringify({ id: message.id, result: {} }))
          },
        },
      }),
    ),
    (running) => Effect.sync(() => running.stop(true)),
  )
  const push = (method: string, params: Json) => Effect.sync(() => peers.forEach((peer) => peer.send(JSON.stringify({ method, params }))))
  return { socket: `ws://127.0.0.1:${server.port}/devtools/page/1`, heard, push, close: Effect.sync(() => peers.forEach((peer) => peer.close())) }
})

const frame = (data: string, sessionId: number) => ({ data, sessionId, metadata: { deviceWidth: 640, deviceHeight: 352, offsetTop: 0, pageScaleFactor: 1 } })

describe("the DevTools client", () => {
  effectTest(
    "answers commands in order, fails on an error answer, acknowledges frames and keeps the newest, names main-frame navigations, and fails every wait once closed",
    Effect.scoped(
      Effect.gen(function* () {
        const stand = yield* debuggerStandIn
        const tab = yield* connect(stand.socket, "http://127.0.0.1:8765/")
        yield* tab.send([{ method: "Page.enable", params: {} }, { method: "Page.navigate", params: { url: "http://127.0.0.1:8765/" } }])
        expect((yield* Queue.take(stand.heard)).method).toBe("Page.enable")
        expect(yield* Queue.take(stand.heard)).toMatchObject({ method: "Page.navigate", params: { url: "http://127.0.0.1:8765/" } })
        expect(yield* tab.ask("1 === 1")).toBe(true)
        yield* Queue.take(stand.heard)
        expect((yield* Effect.flip(tab.send([{ method: "Bad.method", params: {} }]))).message).toBe("'Bad.method' wasn't found")
        yield* Queue.take(stand.heard)
        yield* stand.push("Page.screencastFrame", frame("old", 1))
        yield* stand.push("Page.screencastFrame", frame("new", 2))
        expect(yield* Queue.take(stand.heard)).toMatchObject({ method: "Page.screencastFrameAck", params: { sessionId: 1 } })
        expect(yield* Queue.take(stand.heard)).toMatchObject({ method: "Page.screencastFrameAck", params: { sessionId: 2 } })
        expect(yield* tab.frame).toEqual({ data: "new", width: 640, height: 352 })
        yield* stand.push("Page.frameNavigated", { frame: { id: "c", parentId: "m", url: "http://ads.example/" } })
        yield* stand.push("Page.frameNavigated", { frame: { id: "m", url: "http://127.0.0.1:8765/second.html" } })
        expect(yield* tab.url).toBe("http://127.0.0.1:8765/second.html")
        yield* stand.push("Page.navigatedWithinDocument", { frameId: "m", url: "http://127.0.0.1:8765/second.html#part" })
        expect(yield* tab.url).toBe("http://127.0.0.1:8765/second.html#part")
        yield* stand.close
        expect(Exit.isFailure(yield* Effect.exit(tab.frame))).toBe(true)
        expect((yield* Effect.flip(tab.url)).message).toBe("the browser closed")
      }),
    ),
    10_000,
  )

  effectTest(
    "a socket that does not answer is an error naming it",
    Effect.scoped(Effect.gen(function* () {
      const failed = yield* Effect.flip(connect("ws://127.0.0.1:9/devtools/page/1", "http://127.0.0.1:8765/"))
      expect(failed.message).toBe("cannot reach the browser's debugger at ws://127.0.0.1:9/devtools/page/1")
    })),
    10_000,
  )
})
