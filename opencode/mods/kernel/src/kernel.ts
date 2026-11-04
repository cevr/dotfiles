/**
 * The host's handle on one worker process: start it, run a cell under the
 * compute limit, take and restore snapshots, kill it. Plain promises; the
 * plugin decides when a kernel starts and ends.
 *
 * The limit counts the worker's own compute only: its clock stops while a
 * host tool call is in flight and starts again once the reply is sent. Past
 * the limit the worker's process group is killed, and with it every binding
 * since the last snapshot.
 *
 * @module
 */
import { join } from "node:path"
import {
  encodeFrame,
  makeBoundedOutput,
  makeFrameReader,
  makeOutputScanner,
  MAX_DISPLAY_CHARS,
  MAX_DISPLAY_HEAD_CHARS,
  MAX_REPLY_BYTES,
  type Evaluation,
  type Json,
  type Listing,
  type Request,
  type Response,
  type Snapshot,
  type SnapshotBinding,
} from "./protocol.ts"

/** The worker entry beside this file. */
export const WORKER = join(import.meta.dir, "worker.ts")
/** How long a new worker may take to say it is ready. */
const READY_MS = 10_000

/** A kernel failure the model should see as the tool's error. */
export class KernelError extends Error {
  override readonly name = "KernelError"
}

export interface KernelOptions {
  /** The session's working directory: the worker runs there. */
  readonly cwd: string
  /** The compute limit of one cell, and of a snapshot or restore, in ms. */
  readonly timeoutMs: number
  /** The Bun to run; defaults to this process's own executable. */
  readonly runtime?: string
}

/** Runs one tool for a cell; rejects with the message the cell should see. */
export type CallTool = (name: string, input: Json) => Promise<Json>

/** One cell's outcome: what it printed outside `console`, and its evaluation. */
export interface CellResult extends Evaluation {
  /** stdout and stderr the cell or its children wrote, outside `console`. */
  readonly output: string
}

/** A cell in flight: its frames, its output, and the clock that bounds it. */
interface Running {
  readonly id: string
  readonly token: string
  readonly call: CallTool
  readonly output: ReturnType<typeof makeBoundedOutput>
  outputEnded: boolean
  evaluation?: Evaluation
  readonly resolve: (result: CellResult) => void
  readonly reject: (error: Error) => void
}

export class Kernel {
  private readonly process: Bun.Subprocess<"ignore", "pipe", "ignore">
  private readonly writer: Bun.FileSink
  private readonly waiting = new Map<string, { resolve: (frame: Response) => void; reject: (error: Error) => void }>()
  private running: Running | undefined
  private sequence = 0
  private ended: KernelError | undefined
  private readonly readyPromise: Promise<void>
  /** The last words of a worker that died, for the error. */
  private readonly diagnostics = makeBoundedOutput({ limit: 4096, headLimit: 1024 })
  // The compute clock: time left, and when it last started; paused while host calls are in flight.
  private left = 0
  private startedAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private calls = 0

  private constructor(private readonly options: KernelOptions) {
    this.process = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        // One pipe for stdout and stderr, so the cell's output arrives in write order.
        'exec "$@" 2>&1',
        "opencode-kernel",
        options.runtime ?? process.execPath,
        "--config=/dev/null",
        "--no-env-file",
        WORKER,
      ],
      {
        cwd: options.cwd,
        // A compiled OpenCode binary is Bun inside; this makes it act as `bun`.
        env: { ...process.env, BUN_BE_BUN: "1" },
        stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"],
        // Its own process group, so a kill takes the processes a cell started.
        detached: true,
      },
    )
    this.writer = Bun.file(this.process.stdio[4] as number).writer()
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.waiting.set("ready", { resolve: () => resolve(), reject })
    })
    void this.readFrames()
    void this.readOutput()
    void this.process.exited.then((code) => this.end(new KernelError(`The kernel worker exited (${this.process.signalCode ?? `code ${code}`})`)))
  }

  /** Starts a worker in `options.cwd` and waits until it is ready. */
  static async start(options: KernelOptions): Promise<Kernel> {
    const kernel = new Kernel(options)
    const timer = setTimeout(() => kernel.kill(new KernelError("The kernel worker did not start in time")), READY_MS)
    try {
      await kernel.readyPromise
    } finally {
      clearTimeout(timer)
    }
    return kernel
  }

  /** Whether the worker still runs. */
  get alive(): boolean {
    return this.ended === undefined
  }

  /** Runs one cell. `call` runs its tool calls; an abort kills the worker. */
  evaluate(source: string, tools: ReadonlyArray<Listing>, call: CallTool, signal?: AbortSignal): Promise<CellResult> {
    if (this.ended) return Promise.reject(this.ended)
    if (this.running) return Promise.reject(new KernelError("A cell is already running in this kernel"))
    const id = this.nextId()
    const token = crypto.randomUUID()
    return this.bounded(signal, () =>
      new Promise<CellResult>((resolve, reject) => {
        this.running = {
          id,
          token,
          call,
          output: makeBoundedOutput({ limit: MAX_DISPLAY_CHARS, headLimit: MAX_DISPLAY_HEAD_CHARS }),
          outputEnded: false,
          resolve,
          reject,
        }
        this.send({ type: "evaluate", id, token, source, tools })
      }),
    ).finally(() => {
      this.running = undefined
    })
  }

  /** The worker's bindings as tagged JSON, with those it could not encode named. */
  async snapshot(): Promise<Snapshot> {
    const id = this.nextId()
    const frame = await this.bounded(undefined, () => this.request({ type: "snapshot", id }))
    if (frame.type !== "snapshot") throw new KernelError(`Expected a snapshot, got ${frame.type}`)
    return { bindings: frame.bindings, omitted: frame.omitted }
  }

  /** Puts bindings back into the worker; resolves to the names it defined. */
  async restore(bindings: ReadonlyArray<SnapshotBinding>): Promise<ReadonlyArray<string>> {
    const id = this.nextId()
    const frame = await this.bounded(undefined, () => this.request({ type: "restore", id, bindings }))
    if (frame.type !== "restored") throw new KernelError(`Expected a restore, got ${frame.type}`)
    return frame.names
  }

  /** Kills the worker's process group; what is in flight fails with `reason`. */
  kill(reason = new KernelError("The kernel was stopped")): void {
    if (!this.ended) {
      try {
        process.kill(-this.process.pid, "SIGKILL")
      } catch {
        this.process.kill("SIGKILL")
      }
    }
    this.end(reason)
  }

  private nextId() {
    return String(++this.sequence)
  }

  private send(frame: Request) {
    if (this.ended) return
    try {
      this.writer.write(encodeFrame(frame))
      void Promise.resolve(this.writer.flush()).catch(() => undefined)
    } catch (cause) {
      this.kill(new KernelError(`Cannot send to the kernel worker: ${cause instanceof Error ? cause.message : String(cause)}`))
    }
  }

  private request(frame: Extract<Request, { id: string }>): Promise<Response> {
    if (this.ended) return Promise.reject(this.ended)
    return new Promise((resolve, reject) => {
      this.waiting.set(frame.id, { resolve, reject })
      this.send(frame)
    })
  }

  /** Runs `work` under the compute limit and `signal`: past either, the worker dies. */
  private async bounded<A>(signal: AbortSignal | undefined, work: () => Promise<A>): Promise<A> {
    if (signal?.aborted) throw new KernelError("Aborted before the kernel ran")
    const abort = () => this.kill(new KernelError("Aborted: the kernel worker was stopped and its state since the last call is lost"))
    signal?.addEventListener("abort", abort, { once: true })
    this.left = this.options.timeoutMs
    this.calls = 0
    this.resume()
    try {
      return await work()
    } finally {
      this.pause()
      signal?.removeEventListener("abort", abort)
    }
  }

  private resume() {
    this.startedAt = performance.now()
    this.timer = setTimeout(
      () =>
        this.kill(
          new KernelError(
            `The cell used its ${this.options.timeoutMs / 1000} s of compute; the worker was killed and its state since the last call is lost`,
          ),
        ),
      Math.max(0, this.left),
    )
  }

  private pause() {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.left -= performance.now() - this.startedAt
  }

  /** One tool call: the clock stops while it runs and starts again once the reply is sent. */
  private async hostCall(running: Running, call: string, name: string, input: Json) {
    if (this.calls++ === 0) this.pause()
    let reply: Request
    try {
      const value = await running.call(name, input)
      reply = { type: "reply", call, ok: true, value }
      const size = encodeFrame(reply).byteLength
      if (size > MAX_REPLY_BYTES)
        reply = { type: "reply", call, ok: false, message: `tools.${name} returned ${size} bytes, over the kernel's ${MAX_REPLY_BYTES}` }
    } catch (cause) {
      reply = { type: "reply", call, ok: false, message: cause instanceof Error ? cause.message : String(cause) }
    }
    if (this.running !== running || this.ended) return
    this.send(reply)
    if (--this.calls === 0) this.resume()
  }

  private receive(frame: Response) {
    if (frame.type === "ready") return this.take("ready")?.resolve(frame)
    const running = this.running
    if (frame.type === "call") {
      if (running) void this.hostCall(running, frame.call, frame.name, frame.input)
      return
    }
    if (frame.type === "evaluated") {
      if (!running || running.id !== frame.id) return
      running.evaluation = { ok: frame.ok, display: frame.display, truncated: frame.truncated, bindings: frame.bindings }
      return this.settle(running)
    }
    this.take(frame.id)?.resolve(frame)
  }

  private take(id: string) {
    const entry = this.waiting.get(id)
    this.waiting.delete(id)
    return entry
  }

  /** A cell ends once its result frame and its output marker are both in: they come on separate pipes. */
  private settle(running: Running) {
    if (!running.evaluation || !running.outputEnded) return
    running.resolve({ ...running.evaluation, output: running.output.read() })
  }

  private async readFrames() {
    const reader = makeFrameReader()
    try {
      for await (const chunk of Bun.file(this.process.stdio[3] as number).stream())
        for (const frame of reader.push(chunk)) this.receive(frame as Response)
    } catch (cause) {
      this.kill(new KernelError(`The kernel worker sent a bad frame: ${cause instanceof Error ? cause.message : String(cause)}`))
    }
  }

  private async readOutput() {
    const scanner = makeOutputScanner(() => this.running?.token)
    const decoder = new TextDecoder()
    for await (const chunk of this.process.stdout) {
      for (const segment of scanner.push(decoder.decode(chunk, { stream: true }))) {
        const running = this.running
        // Output no cell claims (a timer's late write) is kept only as a dying worker's last words.
        if (!running || running.outputEnded) this.diagnostics.append(segment.text)
        else running.output.append(segment.text)
        if (segment.marker !== undefined && running && segment.marker === running.token) {
          running.outputEnded = true
          this.settle(running)
        }
      }
    }
  }

  private end(reason: KernelError) {
    if (this.ended) return
    const words = this.diagnostics.read().trim()
    this.ended = words === "" ? reason : new KernelError(`${reason.message}\n${words}`)
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const entry of this.waiting.values()) entry.reject(this.ended)
    this.waiting.clear()
    this.running?.reject(this.ended)
    try {
      void Promise.resolve(this.writer.end()).catch(() => undefined)
    } catch {}
  }
}
