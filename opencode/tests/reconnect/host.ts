// The platform under the reconnect fixture (tests/reconnect/fixture.ts): Bun's Effect platform
// layer (@effect/platform-bun), as sim-world's real run uses it (tests/host-laws/real.ts). It gives
// the files their file system, child processes and HTTP client (`Platform`), an HTTP listener that
// can stop and listen again on its port (`listen`), the fork's CLI run to its end (`run`), and what
// they read from the environment (`ENV`).
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Exit, Layer, Scope, Stream } from "effect"
import { FetchHttpClient, HttpServer, type HttpServerRequest, type HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** The services a reconnect case runs on: Bun's file system, path, child processes, and a fetch HTTP client. */
export const Platform = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

/** What the files read from the environment: the fork (OPENCODE_DEV, required), an old TUI binary to run ("" runs the fork's), PATH. */
export const ENV = Config.all({
  fork: Config.String("OPENCODE_DEV"),
  binary: Config.String("OPENCODE_RECONNECT_TUI_BINARY").pipe(Config.withDefault("")),
  path: Config.String("PATH"),
})

/** An HTTP listener on 127.0.0.1: its port, and a stop that ends its connections and frees the port. */
export interface Listener {
  readonly port: number
  readonly stop: Effect.Effect<void>
}

/**
 * Listens on `port` (0: any free one) and answers each request with `respond`; no idle timeout, so
 * a held stream stays open. The listener lives in a scope of its own, closed by `stop`: what it
 * still serves (a held stream, a request in flight) is interrupted, so its clients see the
 * connection end, as in a restart.
 */
export const listen = <R>(port: number, respond: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpServerRequest.HttpServerRequest>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port, idleTimeout: 0, disablePreemptiveShutdown: true }).pipe(Scope.provide(scope))
    yield* server.serve(respond).pipe(Scope.provide(scope))
    return { port: Number(new URL(HttpServer.formatAddress(server.address)).port), stop: Scope.close(scope, Exit.void) } satisfies Listener
  }).pipe(Effect.orDie)

/** One run of a command: its exit code and output. */
export interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** A child's whole output, as text. */
const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/**
 * `argv` in `cwd` with exactly `env`, run to its end in a process group of its own. The fork's
 * `service start` and `service restart` leave the service running on purpose: the service is in a
 * group of its own (the fork starts it detached), so the end of this run's group does not stop it;
 * `service stop` does.
 */
export const run = (argv: ReadonlyArray<string>, cwd: string, env: { readonly [name: string]: string }) =>
  Effect.gen(function* () {
    const [command = "", ...args] = argv
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, env, extendEnv: false, stdin: "ignore", forceKillAfter: "3 seconds" }))
    const [code, out, err] = yield* Effect.all([child.exitCode, text(child.stdout), text(child.stderr)], { concurrency: 3 })
    return { code, out, err } satisfies Ran
  }).pipe(Effect.scoped, Effect.orDie)
