// This host on the tailnet, read from the system: its interfaces (node:os) and Tailscale's status
// (`tailscale status --json`, the CLI on PATH or the Mac app's). bind.ts's `tailnetOf` decides from them.
// - No CLI, or a CLI that fails or times out: the interfaces alone decide (a Linux host without the CLI on PATH
//   still serves its tailnet address, with no MagicDNS name).
// - The CLI says Tailscale is not running: no tailnet, whatever an interface still lists.
import { hostname, networkInterfaces } from "node:os"
import { readableStreamToText, spawn } from "bun"
import { Duration, Effect, Option, Schema } from "effect"
import { type InterfaceAddress, type Tailnet, type TailscaleStatus, tailnetOf } from "../bind.ts"

/** Where the Tailscale CLI is looked for, in order. */
export const CLIS: ReadonlyArray<string> = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]

const Status = Schema.Struct({
  BackendState: Schema.String,
  Self: Schema.optionalKey(Schema.Struct({ DNSName: Schema.optionalKey(Schema.String) })),
})
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Status))

/** Tailscale's status as `tailscale status --json` prints it; none for anything else. */
export const statusOf = (text: string): Option.Option<TailscaleStatus> =>
  Option.map(decodeStatus(text), (status) => ({
    running: status.BackendState === "Running",
    dnsName: Option.filter(
      Option.map(Option.fromUndefinedOr(status.Self?.DNSName), (name) => name.replace(/\.$/, "")),
      (name) => name !== "",
    ),
  }))

/** One CLI's status, or none: not there, failed, or past five seconds. */
const statusFrom = (cli: string): Effect.Effect<Option.Option<TailscaleStatus>> =>
  Effect.try(() => spawn([cli, "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) =>
      Effect.all([Effect.tryPromise(() => child.exited), Effect.tryPromise(() => readableStreamToText(child.stdout))], { concurrency: 2 }).pipe(
        Effect.map(([code, text]) => Option.flatMap(Option.liftPredicate(text, () => code === 0), statusOf)),
        Effect.timeout(Duration.seconds(5)),
        Effect.onExit(() => Effect.sync(() => void child.kill())),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<TailscaleStatus>()),
  )

/** The first CLI that answers. */
const status: Effect.Effect<Option.Option<TailscaleStatus>> = Effect.reduce(CLIS, () => Option.none<TailscaleStatus>(), (found, cli) =>
  Option.match(found, { onSome: () => Effect.succeed(found), onNone: () => statusFrom(cli) }),
)

/** The host's interface addresses. */
const interfaces = Effect.sync((): ReadonlyArray<InterfaceAddress> => Object.values(networkInterfaces()).flatMap((each) => Option.getOrElse(Option.fromUndefinedOr(each), () => [])))

/** This host's name, as the health line gives it: its first label. */
export const hostName: Effect.Effect<string> = Effect.sync(() => hostname().split(".")[0] ?? hostname())

/** This host on the tailnet now. */
export const probe: Effect.Effect<Tailnet> = Effect.map(Effect.all([interfaces, status]), ([listed, found]) => tailnetOf(listed, found))
