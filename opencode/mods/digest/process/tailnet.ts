// This host on the tailnet, read from the system: its interfaces (node:os) and Tailscale's status
// (`tailscale status --json`). bind.ts's `tailnetOf` decides from them: an address must be in the status's
// `Self.TailscaleIPs` and on an interface.
// - The CLI is the first of CLIS that exists, each an absolute path, never looked up through PATH: a `tailscale`
//   earlier on PATH cannot name addresses or Host names.
// - No CLI, a non-zero exit, past STATUS_TIMEOUT, or output that does not parse: no status, so no tailnet, with the
//   reason (`no-cli`, `cli-failed`, `cli-timeout`, `unparseable`).
import { hostname, networkInterfaces } from "node:os"
import { file, readableStreamToText, spawn } from "bun"
import { Duration, Effect, Option, Schema } from "effect"
import { type InterfaceAddress, StatusRead, type Tailnet, type TailscaleStatus, tailnetOf } from "../bind.ts"
import { exclusionsFrom } from "../members.ts"

/**
 * Where the Tailscale CLI is, in order: the Mac app's, Homebrew's (Apple silicon, then Intel), then the Linux
 * packages' (/usr/bin on Debian and Ubuntu, /usr/sbin on some others). The owner's Mac has Homebrew's, the workbox
 * /usr/bin's.
 */
export const CLIS: ReadonlyArray<string> = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/usr/sbin/tailscale",
]

/** How long the CLI has to answer. */
export const STATUS_TIMEOUT = Duration.seconds(5)

const Node = Schema.Struct({
  DNSName: Schema.optionalKey(Schema.String),
  ID: Schema.optionalKey(Schema.String),
  HostName: Schema.optionalKey(Schema.String),
  TailscaleIPs: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  UserID: Schema.optionalKey(Schema.Number),
  Tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  ShareeNode: Schema.optionalKey(Schema.Boolean),
})
const Status = Schema.Struct({
  BackendState: Schema.String,
  Self: Schema.optionalKey(Node),
  Peer: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Node))),
})
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Status))

type NodeStatus = typeof Node.Type

/** A node's MagicDNS name, without its trailing dot; none for none or an empty one. */
const dnsNameOf = (node: Option.Option<NodeStatus>) =>
  Option.filter(
    Option.map(Option.flatMap(node, (each) => Option.fromUndefinedOr(each.DNSName)), (name) => name.replace(/\.$/, "")),
    (name) => name !== "",
  )

/** A list the status may leave out or give as null: empty then. */
const listOf = (list: Option.Option<ReadonlyArray<string>>): ReadonlyArray<string> => Option.getOrElse(list, () => [])

/** Tailscale's status as `tailscale status --json` prints it; none for anything else. */
export const statusOf = (text: string): Option.Option<TailscaleStatus> =>
  Option.map(decodeStatus(text), (status) => {
    const self = Option.fromUndefinedOr(status.Self)
    return {
      backendState: status.BackendState,
      dnsName: dnsNameOf(self),
      ips: listOf(Option.flatMap(self, (each) => Option.fromNullishOr(each.TailscaleIPs))),
      userId: Option.flatMap(self, (each) => Option.fromUndefinedOr(each.UserID)),
      tagged: listOf(Option.flatMap(self, (each) => Option.fromNullishOr(each.Tags))).length > 0,
      peers: Object.values(Option.getOrElse(Option.fromNullishOr(status.Peer), () => ({}))).map((peer) => ({
        dnsName: dnsNameOf(Option.some(peer)),
        stableId: Option.filter(Option.fromUndefinedOr(peer.ID), (id) => id !== ""),
        hostName: Option.getOrElse(Option.fromUndefinedOr(peer.HostName), () => ""),
        ips: listOf(Option.fromNullishOr(peer.TailscaleIPs)),
        userId: Option.fromUndefinedOr(peer.UserID),
        tagged: listOf(Option.fromNullishOr(peer.Tags)).length > 0,
        shared: peer.ShareeNode === true,
      })),
    }
  })

/** The first of `clis` that exists. */
const cliOf = (clis: ReadonlyArray<string>): Effect.Effect<Option.Option<string>> =>
  Effect.reduce(clis, () => Option.none<string>(), (found, cli) =>
    Option.match(found, {
      onSome: () => Effect.succeed(found),
      onNone: () => Effect.map(Effect.orElseSucceed(Effect.tryPromise(() => file(cli).exists()), () => false), (exists) => Option.liftPredicate(cli, () => exists)),
    }),
  )

/** What `cli status --json` answered: its exit code and output, or a timeout. */
const ran = (cli: string, timeout: Duration.Duration) =>
  Effect.try(() => spawn([cli, "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) =>
      Effect.all([Effect.tryPromise(() => child.exited), Effect.tryPromise(() => readableStreamToText(child.stdout))], { concurrency: 2 }).pipe(
        Effect.timeoutOption(timeout),
        Effect.onExit(() => Effect.sync(() => void child.kill())),
      ),
    ),
  )

/** Tailscale's status from the first of `clis` that exists, or why there is none. */
export const statusFrom = (clis: ReadonlyArray<string> = CLIS, timeout: Duration.Duration = STATUS_TIMEOUT): Effect.Effect<StatusRead> =>
  Effect.flatMap(cliOf(clis), (cli) =>
    Option.match(cli, {
      onNone: () => Effect.succeed(StatusRead.Unread({ why: "no-cli" })),
      onSome: (path) =>
        ran(path, timeout).pipe(
          Effect.map((answered) =>
            Option.match(answered, {
              onNone: () => StatusRead.Unread({ why: "cli-timeout" }),
              onSome: ([code, text]) =>
                Option.match(Option.liftPredicate(text, () => code === 0), {
                  onNone: () => StatusRead.Unread({ why: "cli-failed" }),
                  onSome: (output) =>
                    Option.match(statusOf(output), { onNone: () => StatusRead.Unread({ why: "unparseable" }), onSome: (status) => StatusRead.Read({ status }) }),
                }),
            }),
          ),
          Effect.orElseSucceed(() => StatusRead.Unread({ why: "cli-failed" })),
        ),
    }),
  )

/**
 * `digest.excludedDevices` for the installer: each of `names` with its device's stable ID among his own devices, as
 * Tailscale's status says now (members.ts `exclusionsFrom`). A promise of plain data, so a script on another Effect
 * runtime can call it.
 */
export const readExclusions = (names: ReadonlyArray<string>, clis: ReadonlyArray<string> = CLIS): Promise<ReadonlyArray<{ readonly name: string; readonly id?: string }>> =>
  Effect.runPromise(Effect.map(statusFrom(clis), (read) => exclusionsFrom(names, read)))

/** The host's interface addresses. */
const interfaces = Effect.sync((): ReadonlyArray<InterfaceAddress> => Object.values(networkInterfaces()).flatMap((each) => Option.getOrElse(Option.fromUndefinedOr(each), () => [])))

/** This host's name, as the health line gives it: its first label. */
export const hostName: Effect.Effect<string> = Effect.sync(() => hostname().split(".")[0] ?? hostname())

/** This host on the tailnet, and the status it was read from (members.ts reads his devices from it). */
export interface Probed {
  readonly tailnet: Tailnet
  readonly status: StatusRead
}

/** This host on the tailnet now, and the status it was read from. */
export const probeWithStatus: Effect.Effect<Probed> = Effect.map(Effect.all([interfaces, statusFrom()]), ([listed, read]) => ({ tailnet: tailnetOf(listed, read), status: read }))

/** This host on the tailnet now. */
export const probe: Effect.Effect<Tailnet> = Effect.map(probeWithStatus, (read) => read.tailnet)
