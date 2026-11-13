// The platform under the reconnect fixture (tests/reconnect/fixture.ts): the one module of the
// reconnect-session*.test.ts files that touches Bun, the process, the file system and the network
// directly. The root has no Effect platform layer (no @effect/platform-bun), so these are the
// adapters such a layer would give: an HTTP listener, a detached child run to its end, a fetch, a
// few synchronous file operations, the environment read once, and the bun:test bridge that runs a
// case's Effect. Everything else in the fixture is plain Effect.
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { Effect, Option, type Scope } from "effect"

const { OPENCODE_DEV: fork = "", OPENCODE_RECONNECT_TUI_BINARY: binary = "", PATH: path = "" } = process.env

/** What the files read from the environment: the fork ("" skips them), an old TUI binary to run ("" runs the fork's), PATH and this bun. */
export const ENV = { fork, binary, path, bun: process.execPath }

/** An HTTP listener on 127.0.0.1: its port, and a stop that closes its connections. */
export interface Listener {
  readonly port: number
  readonly stop: () => void
}

/** Listens on `port` (0: any free one) and answers each request with `respond`'s Effect; no idle timeout, so a held stream stays open. */
export const listen = (port: number, respond: (request: Request) => Effect.Effect<Response>): Listener => {
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (request) => Effect.runPromise(respond(request)) })
  return { port: Option.getOrElse(Option.fromUndefinedOr(server.port), () => port), stop: () => server.stop(true) }
}

/** One run of a command: its exit code and output. */
export interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/**
 * `argv` in `cwd` with exactly `env`, run to its end, in a process group of its own. Not `owned`
 * (tests/owned.ts): the fork's `service start` and `service restart` leave the service running on
 * purpose; `service stop` ends it, and accept's leak check stops one that is left.
 */
export const run = (argv: ReadonlyArray<string>, cwd: string, env: { readonly [name: string]: string }) =>
  Effect.gen(function* () {
    const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe", detached: true })
    const [code, out, err] = yield* Effect.all([Effect.promise(() => child.exited), Effect.promise(() => child.stdout.text()), Effect.promise(() => child.stderr.text())], { concurrency: 3 })
    return { code, out, err } satisfies Ran
  })

/** A request to `url`; a refused connection or an aborted request fails. */
export const send = (url: URL, init: RequestInit) => Effect.tryPromise(() => fetch(url, init))

/** A response's body that ends quietly when its connection is cut (a restart cuts a stream), rather than erroring. */
export const endsQuietly = (response: Response) =>
  Option.match(Option.fromNullishOr(response.body), {
    onNone: () => response.body,
    onSome: (upstream) => {
      const reader = upstream.getReader()
      return new ReadableStream<Uint8Array>({
        pull: (controller) =>
          Effect.runPromise(
            Effect.tryPromise(() => reader.read()).pipe(
              Effect.match({
                onFailure: () => controller.close(),
                onSuccess: (read) => {
                  if (read.done) controller.close()
                  else controller.enqueue(read.value)
                },
              }),
            ),
          ),
        cancel: () => Effect.runPromise(Effect.ignore(Effect.tryPromise(() => reader.cancel()))),
      })
    },
  })

/** The synchronous file operations the fixture makes its scratch HOME with. */
export const files = {
  exists: (file: string) => existsSync(file),
  /** One folder, its parent already there. */
  makeDir: (dir: string) => mkdirSync(dir),
  write: (file: string, text: string) => writeFileSync(file, text),
  copy: (from: string, to: string) => copyFileSync(from, to),
  remove: (dir: string) => rmSync(dir, { recursive: true, force: true }),
  /** The path with its symbolic links resolved (macOS's /var is /private/var), as a process started there sees its directory. */
  real: (file: string) => realpathSync(file),
}

/** The fork's promise client module, found at run time. */
export const importClient = <A>(fork: string) => Effect.promise((): Promise<A> => import(`${fork}/packages/client/src/promise/index.ts`))

/** A bun:test body that runs a case's scoped Effect to its end. */
export const runCase = <E>(effect: Effect.Effect<void, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** What a file prints when OPENCODE_DEV is not set and it skips. */
export const skipNotice = (file: string) => {
  if (fork === "") console.warn(`${file}: skipped. Set OPENCODE_DEV to the fork.`)
}
