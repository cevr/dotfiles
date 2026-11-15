// The iOS simulators through `xcrun simctl`, as the Simulators, read only:
// it lists the booted ones and screenshots one, nothing else (never boot,
// shutdown, install or erase). On a Mac it runs simctl itself; for another
// host's view it runs the same through `ssh <host>` in batch mode (a key
// must work and Remote Login be on; it never asks for a password), each
// screenshot written to a temporary file on the Mac, sent back on stdout and
// removed there. Each run is a process group the viewer kills if it stops.
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { isPng } from "../graphics.ts"
import { type SimHost, SimFailed, Simulators } from "../service.ts"
import { type Device, isUdid, osOf } from "../sim.ts"
import { lastLine, type Ran, runGroup } from "./group.ts"

/** How long one simctl or ssh run may take. */
const RUN_MS = 15_000

/** What the pane says when the simulators cannot be reached at all: where they run and how to reach them. */
export const NOT_A_MAC =
  "iOS simulators run only on a Mac: set REX_SHOW_SIM_HOST=user@mac (Remote Login on in System Settings › General › Sharing, and this host's ssh key in the Mac's ~/.ssh/authorized_keys)"

/** The Mac's words when ssh could not log in, and what to do. */
const sshRefused = (host: string, err: string) =>
  `cannot reach ${host} with ssh (${lastLine(err)}): on the Mac turn on Remote Login (System Settings › General › Sharing) and add this host's public key to ~/.ssh/authorized_keys`

const Listed = Schema.Struct({
  devices: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ udid: Schema.String, name: Schema.String, state: Schema.String, lastUsedAt: Schema.optional(Schema.String) })),
  ),
})
const decodeListed = Schema.decodeUnknownOption(Schema.fromJsonString(Listed))

/** The booted simulators in `simctl list devices booted -j`'s output. */
export const bootedIn = (json: string): Option.Option<ReadonlyArray<Device>> =>
  Option.map(decodeListed(json), (listed) =>
    Object.entries(listed.devices).flatMap(([runtime, devices]) =>
      devices
        .filter((device) => device.state === "Booted")
        .map((device) => ({ udid: device.udid, name: device.name, os: osOf(runtime), used: Option.getOrElse(Option.fromUndefinedOr(device.lastUsedAt), () => "") })),
    ),
  )

/** Whether `host` is a plain ssh destination ([user@]name), never an option. */
export const isHost = (host: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/.test(host)

/** `ssh` in batch mode to `host`, running `command` there. */
export const sshArgs = (host: string, command: string): ReadonlyArray<string> => [
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  host,
  command,
]

/** The shell command that screenshots `udid` on the Mac into a temporary file, prints it and removes it there. */
export const remoteShot = (udid: string) =>
  `f=$(mktemp -t rex-show-sim) && xcrun simctl io ${udid} screenshot --type=png "$f" >/dev/null 2>&1; s=$?; cat "$f"; rm -f "$f"; exit $s`

/** What the simulators on this host can do: the platform it is. */
export interface Places {
  readonly platform: string
}

const failed = (message: string) => new SimFailed({ message })

/** A run of `argv`, failing with why when it cannot start or ends badly; `ssh` exit 255 is a refused login on `host`. */
const ran = (argv: ReadonlyArray<string>, host: Option.Option<string>) =>
  Effect.flatMap(
    Effect.mapError(runGroup(argv, RUN_MS), (why) => failed(`cannot run ${argv[0]}: ${why}`)),
    (done: Ran) =>
      Option.match(Option.filter(done.code, (code) => code === 0), {
        onSome: () => Effect.succeed(done),
        onNone: () =>
          Effect.fail(
            failed(
              Option.match(
                Option.filter(host, () => Option.getOrElse(done.code, () => -1) === 255),
                {
                  onSome: (name) => sshRefused(name, done.err),
                  onNone: () => `${argv.slice(0, 4).join(" ")} failed (${Option.match(done.code, { onNone: () => "killed", onSome: (code) => `exit ${code}` })}): ${lastLine(done.err)}`,
                },
              ),
            ),
          ),
      }),
  )

const booted = (done: Ran) =>
  Option.match(bootedIn(new TextDecoder().decode(done.out)), {
    onNone: () => Effect.fail(failed("simctl listed the simulators in a shape rex-show does not know")),
    onSome: Effect.succeed,
  })

const png = (bytes: Uint8Array) =>
  Option.match(Option.liftPredicate(bytes, isPng), { onNone: () => Effect.fail(failed("simctl's screenshot is not a PNG")), onSome: Effect.succeed })

const safeUdid = (udid: string) => Option.match(Option.liftPredicate(udid, isUdid), { onNone: () => Effect.fail(failed(`not a simulator udid: ${udid}`)), onSome: Effect.succeed })

/** This Mac's simulators. */
const local: SimHost = {
  booted: Effect.flatMap(ran(["xcrun", "simctl", "list", "devices", "booted", "-j"], Option.none()), booted),
  screenshot: (udid) =>
    Effect.acquireUseRelease(
      Effect.sync(() => join(tmpdir(), `rex-show-sim-${crypto.randomUUID()}.png`)),
      (file) =>
        Effect.gen(function* () {
          yield* ran(["xcrun", "simctl", "io", yield* safeUdid(udid), "screenshot", "--type=png", file], Option.none())
          return yield* png(new Uint8Array(yield* Effect.tryPromise({ try: () => readFile(file), catch: () => failed("simctl wrote no screenshot") })))
        }),
      (file) => Effect.promise(() => rm(file, { force: true })),
    ),
}

/** A Mac's simulators over ssh. */
const remote = (host: string): SimHost =>
  Option.match(Option.liftPredicate(host, isHost), {
    onNone: () => ({ booted: Effect.fail(failed(`REX_SHOW_SIM_HOST is not an ssh host: ${host}`)), screenshot: () => Effect.fail(failed(`REX_SHOW_SIM_HOST is not an ssh host: ${host}`)) }),
    onSome: (name) => ({
      booted: Effect.flatMap(ran(sshArgs(name, "xcrun simctl list devices booted -j"), Option.some(name)), booted),
      screenshot: (udid) => Effect.flatMap(Effect.flatMap(safeUdid(udid), (safe) => ran(sshArgs(name, remoteShot(safe)), Option.some(name))), (done) => png(done.out)),
    }),
  })

/** Nowhere to reach a simulator: not a Mac, and no Mac named. */
const nowhere: SimHost = { booted: Effect.fail(failed(NOT_A_MAC)), screenshot: () => Effect.fail(failed(NOT_A_MAC)) }

/** The simulators reachable from a host of `places.platform`. */
export const layer = (places: Places) =>
  Layer.succeed(
    Simulators,
    Simulators.of({
      at: (host) => {
        if (host !== "") return remote(host)
        if (places.platform === "darwin") return local
        return nowhere
      },
    }),
  )
