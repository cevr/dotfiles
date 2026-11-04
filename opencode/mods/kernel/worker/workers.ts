// The worker processes: one Bun process per session, running program.ts
// in the session's working directory, spoken to over the worker protocol
// (kernel/frame.ts, kernel/wire.ts).
//
// The compute limit counts the worker's own compute only: its clock stops
// while a host tool call is in flight and starts again once the reply is sent.
// Past the limit the worker's process group is killed, and with it every
// binding since the last snapshot.
//
// Everything a worker's operations wait on (its ready frame, a reply, a cell's
// result and the end of its output) settles when the worker ends, with the
// reason it ended and the last words it wrote outside a cell.
import { join } from "node:path"
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { ABORTED } from "../kernel/model.ts"
import { Response, type Evaluation, type Json, type Request, type SnapshotBinding } from "../kernel/frame.ts"
import type { KernelSessionId } from "../kernel/session.ts"
import { WorkerLost, Workers, type Cell, type CellResult } from "../kernel/service.ts"
import { MAX_DISPLAY_CHARS, MAX_DISPLAY_HEAD_CHARS, MAX_REPLY_BYTES, READY_MS } from "../kernel/limits.ts"
import { makeBoundedOutput } from "../kernel/output.ts"
import { messageOf } from "../kernel/tools.ts"
import { encodeFrame, makeFrameReader, makeOutputScanner, oversized, REQUEST_FD, RESPONSE_FD } from "../kernel/wire.ts"

/** The worker entry. */
export const WORKER = join(import.meta.dir, "program.ts")

/** The workers' settings, from the plugin's options. */
export interface Config {
  /** The compute limit of one cell, and of a snapshot or restore, in ms. */
  readonly timeoutMs: number
  /** The Bun to run; defaults to this process's own executable. */
  readonly runtime?: string
}

const STOPPED = "The kernel was stopped"

/** A cell in flight: its output, and what settles it. */
interface Running {
  readonly id: string
  readonly token: string
  readonly call: Cell["call"]
  readonly output: ReturnType<typeof makeBoundedOutput>
  outputEnded: boolean
  readonly evaluated: Deferred.Deferred<Evaluation, WorkerLost>
  readonly outputDone: Deferred.Deferred<void, WorkerLost>
}

/** One worker process and what is in flight on it. */
interface Handle {
  readonly process: Bun.Subprocess<"ignore", "pipe", "ignore">
  readonly writer: Bun.FileSink
  /** Its readers, its clock and its host calls: closed when it ends. */
  readonly scope: Scope.Closeable
  readonly waiting: Map<string, Deferred.Deferred<Response, WorkerLost>>
  /** The last words of a worker that died, for the error. */
  readonly diagnostics: ReturnType<typeof makeBoundedOutput>
  running: Running | undefined
  sequence: number
  ended: WorkerLost | undefined
  // The compute clock: time left, and when it last started; paused while host calls are in flight.
  left: number
  startedAt: number
  timer: Fiber.Fiber<void> | undefined
  calls: number
}

const lost = (cause: unknown) => new WorkerLost({ message: messageOf(cause) })

/** Ends the handle: everything in flight fails with `reason` and the worker's last words. Once. */
const end = (handle: Handle, reason: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (handle.ended !== undefined) return Effect.void
    const words = handle.diagnostics.read().trim()
    const ended = new WorkerLost({ message: words === "" ? reason : `${reason}\n${words}` })
    handle.ended = ended
    handle.timer = undefined
    for (const waiting of handle.waiting.values()) Deferred.doneUnsafe(waiting, Effect.fail(ended))
    handle.waiting.clear()
    if (handle.running !== undefined) {
      Deferred.doneUnsafe(handle.running.evaluated, Effect.fail(ended))
      Deferred.doneUnsafe(handle.running.outputDone, Effect.fail(ended))
    }
    try {
      void Promise.resolve(handle.writer.end()).catch(() => undefined)
    } catch {}
    // From its own fiber: the caller may be one of the fibers the scope interrupts.
    return Effect.forkDetach(Scope.close(handle.scope, Exit.void)).pipe(Effect.asVoid)
  })

/** Kills the worker's process group, then ends the handle with `reason`. */
const kill = (handle: Handle, reason: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (handle.ended !== undefined) return Effect.void
    killGroup(handle.process)
    return end(handle, reason)
  })

const killGroup = (process_: Bun.Subprocess) => {
  try {
    process.kill(-process_.pid, "SIGKILL")
  } catch {
    process_.kill("SIGKILL")
  }
}

const send = (handle: Handle, frame: Request): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (handle.ended !== undefined) return Effect.void
    const encoded = encodeFrame(frame)
    if (encoded._tag === "Oversized") return kill(handle, `Cannot send to the kernel worker: ${oversized(encoded.size)}`)
    return Effect.try({
      try: () => {
        handle.writer.write(encoded.bytes)
        void Promise.resolve(handle.writer.flush()).catch(() => undefined)
      },
      catch: messageOf,
    }).pipe(Effect.catch((message) => kill(handle, `Cannot send to the kernel worker: ${message}`)))
  })

const nextId = (handle: Handle) => String(++handle.sequence)

const request = (handle: Handle, frame: Extract<Request, { readonly id: string }>) =>
  Effect.suspend(() => {
    if (handle.ended !== undefined) return Effect.fail(handle.ended)
    const reply = Deferred.makeUnsafe<Response, WorkerLost>()
    handle.waiting.set(frame.id, reply)
    return send(handle, frame).pipe(Effect.andThen(Deferred.await(reply)))
  })

const take = (handle: Handle, id: string, frame: Response) => {
  const waiting = handle.waiting.get(id)
  handle.waiting.delete(id)
  if (waiting !== undefined) Deferred.doneUnsafe(waiting, Effect.succeed(frame))
}

export const layer = (config: Config) =>
  Layer.effect(
    Workers,
    Effect.gen(function* () {
      const root = yield* Effect.scope
      const handles = new Map<KernelSessionId, Handle>()
      // Every worker dies with the plugin.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const handle of handles.values()) if (handle.ended === undefined) killGroup(handle.process)
          handles.clear()
        }),
      )

      const computeSpent = `The cell used its ${config.timeoutMs / 1000} s of compute; the worker was killed and its state since the last call is lost`

      const resume = (handle: Handle) =>
        Effect.gen(function* () {
          if (handle.ended !== undefined) return
          handle.startedAt = yield* Clock.currentTimeMillis
          handle.timer = yield* Effect.sleep(Math.max(0, handle.left)).pipe(
            // Cleared first, so the kill does not interrupt the fiber running it.
            Effect.andThen(Effect.sync(() => (handle.timer = undefined))),
            Effect.andThen(kill(handle, computeSpent)),
            Effect.forkIn(handle.scope),
          )
        })

      const pause = (handle: Handle) =>
        Effect.gen(function* () {
          const timer = handle.timer
          if (timer === undefined) return
          handle.timer = undefined
          yield* Fiber.interrupt(timer)
          handle.left -= (yield* Clock.currentTimeMillis) - handle.startedAt
        })

      /** Runs `work` under the compute limit: past it, the worker dies. */
      const bounded = <A>(handle: Handle, work: Effect.Effect<A, WorkerLost>) =>
        Effect.gen(function* () {
          handle.left = config.timeoutMs
          handle.calls = 0
          yield* resume(handle)
          return yield* work
        }).pipe(Effect.ensuring(Effect.suspend(() => pause(handle))))

      /** One tool call: the clock stops while it runs and starts again once the reply is sent. */
      const hostCall = (handle: Handle, running: Running, call: string, name: string, input: Json) =>
        Effect.gen(function* () {
          if (handle.calls++ === 0) yield* pause(handle)
          const reply = yield* running.call(name, input).pipe(
            Effect.map((value): Request => {
              const answer: Request = { type: "reply", call, ok: true, value }
              const encoded = encodeFrame(answer)
              if (encoded._tag === "Oversized") return { type: "reply", call, ok: false, message: oversized(encoded.size) }
              const size = encoded.bytes.byteLength
              return size > MAX_REPLY_BYTES
                ? { type: "reply", call, ok: false, message: `tools.${name} returned ${size} bytes, over the kernel's ${MAX_REPLY_BYTES}` }
                : answer
            }),
            Effect.catch((failed) => Effect.succeed<Request>({ type: "reply", call, ok: false, message: failed.message })),
          )
          if (handle.running !== running || handle.ended !== undefined) return
          yield* send(handle, reply)
          if (--handle.calls === 0) yield* resume(handle)
        })

      const receive = (handle: Handle, frame: Response): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (frame.type === "ready") return Effect.sync(() => take(handle, "ready", frame))
          const running = handle.running
          if (frame.type === "call")
            return running === undefined
              ? Effect.void
              : hostCall(handle, running, frame.call, frame.name, frame.input).pipe(Effect.forkIn(handle.scope), Effect.asVoid)
          if (frame.type === "evaluated")
            return Effect.sync(() => {
              if (running === undefined || running.id !== frame.id) return
              const { ok, display, truncated, bindings } = frame
              Deferred.doneUnsafe(running.evaluated, Effect.succeed({ ok, display, truncated, bindings }))
            })
          return Effect.sync(() => take(handle, frame.id, frame))
        })

      const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Response))

      const readFrames = (handle: Handle, fd: number) =>
        Effect.gen(function* () {
          const reader = makeFrameReader()
          yield* Stream.fromReadableStream({ evaluate: () => Bun.file(fd).stream(), onError: messageOf }).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const read = reader.push(chunk)
                for (const text of read.frames) yield* receive(handle, yield* decodeFrame(text).pipe(Effect.mapError((error) => error.message)))
                if (read.error !== undefined) return yield* Effect.fail(read.error)
              }),
            ),
          )
        }).pipe(Effect.catch((message) => kill(handle, `The kernel worker sent a bad frame: ${message}`)))

      const readOutput = (handle: Handle) =>
        Effect.gen(function* () {
          const scanner = makeOutputScanner(() => handle.running?.token)
          const decoder = new TextDecoder()
          yield* Stream.fromReadableStream({ evaluate: () => handle.process.stdout, onError: messageOf }).pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                for (const segment of scanner.push(decoder.decode(chunk, { stream: true }))) {
                  const running = handle.running
                  // Output no cell claims (a timer's late write) is kept only as a dying worker's last words.
                  if (running === undefined || running.outputEnded) handle.diagnostics.append(segment.text)
                  else running.output.append(segment.text)
                  if (segment.marker !== undefined && running !== undefined && segment.marker === running.token) {
                    running.outputEnded = true
                    Deferred.doneUnsafe(running.outputDone, Effect.void)
                  }
                }
              }),
            ),
          )
        }).pipe(Effect.ignore)

      const spawn = (directory: string) =>
        Effect.try({
          try: () =>
            Bun.spawn(
              [
                "/bin/sh",
                "-c",
                // One pipe for stdout and stderr, so the cell's output arrives in write order.
                'exec "$@" 2>&1',
                "opencode-kernel",
                config.runtime ?? process.execPath,
                "--config=/dev/null",
                "--no-env-file",
                WORKER,
              ],
              {
                cwd: directory,
                // A compiled OpenCode binary is Bun inside; this makes it act as `bun`.
                env: { ...process.env, BUN_BE_BUN: "1" },
                stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"],
                // Its own process group, so a kill takes the processes a cell started.
                detached: true,
              },
            ),
          catch: lost,
        })

      const open = (directory: string) =>
        Effect.gen(function* () {
          const child = yield* spawn(directory)
          const responses = child.stdio[RESPONSE_FD]
          const requests = child.stdio[REQUEST_FD]
          if (typeof responses !== "number" || typeof requests !== "number") {
            killGroup(child)
            return yield* new WorkerLost({ message: "The kernel worker has no protocol pipes" })
          }
          const writer = yield* Effect.try({ try: () => Bun.file(requests).writer(), catch: lost }).pipe(
            Effect.tapError(() => Effect.sync(() => killGroup(child))),
          )
          const handle: Handle = {
            process: child,
            writer,
            scope: yield* Scope.fork(root),
            waiting: new Map(),
            diagnostics: makeBoundedOutput({ limit: 4096, headLimit: 1024 }),
            running: undefined,
            sequence: 0,
            ended: undefined,
            left: 0,
            startedAt: 0,
            timer: undefined,
            calls: 0,
          }
          yield* Scope.addFinalizer(handle.scope, Effect.sync(() => (handle.ended === undefined ? killGroup(child) : undefined)))
          const ready = Deferred.makeUnsafe<Response, WorkerLost>()
          handle.waiting.set("ready", ready)
          yield* readFrames(handle, responses).pipe(Effect.forkIn(handle.scope))
          yield* readOutput(handle).pipe(Effect.forkIn(handle.scope))
          yield* Effect.promise(() => child.exited).pipe(
            Effect.flatMap((code) => end(handle, `The kernel worker exited (${child.signalCode ?? `code ${code}`})`)),
            Effect.forkIn(handle.scope),
          )
          return { handle, ready }
        })

      const live = (session: KernelSessionId) =>
        Effect.suspend(() => {
          const handle = handles.get(session)
          if (handle === undefined) return Effect.fail(new WorkerLost({ message: STOPPED }))
          return handle.ended === undefined ? Effect.succeed(handle) : Effect.fail(handle.ended)
        })

      const stop = Effect.fn("Workers.stop")(function* (session: KernelSessionId) {
        const handle = handles.get(session)
        handles.delete(session)
        if (handle !== undefined) yield* kill(handle, STOPPED)
      })

      const start = Effect.fn("Workers.start")(function* (session: KernelSessionId, directory: string) {
        yield* stop(session)
        const { handle, ready } = yield* open(directory)
        handles.set(session, handle)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: READY_MS,
            orElse: () => kill(handle, "The kernel worker did not start in time").pipe(Effect.andThen(Deferred.await(ready))),
          }),
        )
      })

      const evaluate = Effect.fn("Workers.evaluate")(function* (session: KernelSessionId, cell: Cell) {
        const handle = yield* live(session)
        if (handle.running !== undefined) return yield* new WorkerLost({ message: "A cell is already running in this kernel" })
        const running: Running = {
          id: nextId(handle),
          token: crypto.randomUUID(),
          call: cell.call,
          output: makeBoundedOutput({ limit: MAX_DISPLAY_CHARS, headLimit: MAX_DISPLAY_HEAD_CHARS }),
          outputEnded: false,
          evaluated: Deferred.makeUnsafe(),
          outputDone: Deferred.makeUnsafe(),
        }
        handle.running = running
        return yield* bounded(
          handle,
          Effect.gen(function* () {
            yield* send(handle, { type: "evaluate", id: running.id, token: running.token, source: cell.source, tools: cell.tools })
            // A cell ends once its result frame and its output marker are both in: they come on separate pipes.
            const evaluation = yield* Deferred.await(running.evaluated)
            yield* Deferred.await(running.outputDone)
            return { ...evaluation, output: running.output.read() } satisfies CellResult
          }),
        ).pipe(
          Effect.onInterrupt(() => kill(handle, ABORTED)),
          Effect.ensuring(Effect.sync(() => (handle.running = undefined))),
        )
      })

      const snapshot = Effect.fn("Workers.snapshot")(function* (session: KernelSessionId) {
        const handle = yield* live(session)
        const frame = yield* bounded(handle, request(handle, { type: "snapshot", id: nextId(handle) }))
        if (frame.type !== "snapshot") return yield* new WorkerLost({ message: `Expected a snapshot, got ${frame.type}` })
        return { bindings: frame.bindings, omitted: frame.omitted }
      })

      const restore = Effect.fn("Workers.restore")(function* (session: KernelSessionId, bindings: ReadonlyArray<SnapshotBinding>) {
        const handle = yield* live(session)
        const frame = yield* bounded(handle, request(handle, { type: "restore", id: nextId(handle), bindings }))
        if (frame.type !== "restored") return yield* new WorkerLost({ message: `Expected a restore, got ${frame.type}` })
        return frame.names
      })

      const alive = (session: KernelSessionId) =>
        Effect.sync(() => {
          const handle = handles.get(session)
          return handle !== undefined && handle.ended === undefined
        })

      return Workers.of({ alive, start, evaluate, snapshot, restore, stop })
    }),
  )
