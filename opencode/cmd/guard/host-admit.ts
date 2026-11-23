#!/usr/bin/env bun
import { argv, stdin } from "bun"
import { Cause, Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AdmissionUnavailable } from "@dotfiles/opencode-guard/admission"
import { Counter, OpaqueId, Request } from "@dotfiles/opencode-guard/admission-wire"
import { Holder } from "@dotfiles/opencode-guard/host-resources"
import { CHECK_PROFILE } from "@dotfiles/opencode-guard/host-supply"
import * as Admission from "./admission.ts"

const help = `host-admit v1
  host status --json
  lease request --json                 read one request from stdin
  lease status --id ID --json
  lease watch --id ID --after N --json  replay or wait for changes
  lease run --id ID -- COMMAND [ARGS...]
  lease cancel --id ID --json
  holder put --json                    read a bounded JSONL observation batch
  holder list --json [--after-revision N] [--snapshot N]
  check run [--class check|land-check|vm|inventory|exclusive-check] -- COMMAND [ARGS...]
`

const bad = () => new AdmissionUnavailable({ reason: "invalid-request" })
const output = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const print = (value: Schema.Json) => Console.log(output(value))
const address = Schema.decodeUnknownOption(OpaqueId)
const count = Schema.decodeUnknownOption(Counter)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))
const requestOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const holderOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Holder))

/** Decode legal JSON normally, then reject ambiguous object key spellings,
 * including escaped duplicates that JSON.parse would silently collapse. */
const uniqueKeys = (text: string) => {
  const context: Array<Option.Option<Set<string>>> = []
  for (const token of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\]]/gu)) {
    if (token[1] && token[2]) {
      const key = decodeJsonString(token[1])
      const frame = context.at(-1)
      if (!frame || Option.isNone(frame) || Option.isNone(key) || frame.value.has(key.value)) return false
      frame.value.add(key.value)
    } else if (token[0] === "{") context.push(Option.some(new Set()))
    else if (token[0] === "[") context.push(Option.none())
    else if (token[0] === "}" || token[0] === "]") context.pop()
  }
  return context.length === 0
}

const read = Effect.fn("HostAdmit.stdin")(function* () {
  const text = yield* Effect.tryPromise({ try: () => stdin.text(), catch: bad })
  if (text.length > 262_144) return yield* bad()
  return text
})

type Host = Effect.Success<ReturnType<typeof Admission.open>>
const refused = (reply: { readonly state: string }) => 2 * Number(reply.state === "refused")

const lease = Effect.fn("HostAdmit.lease")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, flag, value, suffix, ...rest] = args
  if (action === "request" && flag === "--json" && args.length === 2) {
    const text = yield* read()
    const request = yield* requestOf(text).pipe(Effect.mapError(bad))
    if (!uniqueKeys(text)) return yield* bad()
    const reply = yield* host.request(request)
    yield* print(reply)
    return refused(reply)
  }
  const id = address(value)
  if (flag !== "--id" || Option.isNone(id)) return yield* bad()
  if (action === "run" && suffix === "--" && rest.length > 0) return yield* host.launch(id.value, rest)
  if ((action === "status" || action === "cancel") && suffix === "--json" && rest.length === 0) {
    const reply = yield* host[action](id.value)
    yield* print(reply)
    return refused(reply)
  }
  const since = count(Number(rest[0]))
  if (action === "watch" && suffix === "--after" && rest.length === 2 && rest[1] === "--json" && Option.isSome(since)) {
    const events = yield* host.watch(id.value, since.value)
    yield* Effect.forEach(events, print, { discard: true })
    return 0
  }
  return yield* bad()
})

const list = Effect.fn("HostAdmit.list")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, first, afterText, next, atText] = args
  const after = count(Number(Option.getOrElse(Option.fromNullishOr(afterText), () => "0")))
  const at = count(Number(atText))
  if (action !== "--json" || (args.length > 1 && (first !== "--after-revision" || args.length < 3)) ||
    (args.length > 3 && (next !== "--snapshot" || Option.isNone(at))) || Option.isNone(after) || args.length > 5) return yield* bad()
  const seen = yield* host.list(after.value, Option.getOrUndefined(at))
  yield* print({ ...seen })
  return 0
})

const holder = Effect.fn("HostAdmit.holder")(function* (host: Host, args: ReadonlyArray<string>) {
  if (args[0] === "list") return yield* list(host, args.slice(1))
  if (args[0] !== "put" || args[1] !== "--json" || args.length !== 2) return yield* bad()
  const text = yield* read()
  const lines = text.trim().split(/\r?\n/u)
  if (lines.length > 128 || !lines.every(uniqueKeys)) return yield* bad()
  const records = yield* Effect.forEach(lines, (line) => holderOf(line).pipe(Effect.mapError(bad)))
  const result = yield* host.put(records)
  yield* print({ version: 1, records: result.map(({ holderId, resourceId, incarnation, revision }) => ({ holderId, resourceId, incarnation, revision })) })
  return 0
})

const purposeOf = Schema.decodeUnknownOption(Request.fields.purpose)
const check = Effect.fn("HostAdmit.check")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, flag, named, delimiter] = args
  const shorthand = flag === "--"
  const purpose = purposeOf((shorthand && "check") || named)
  const payload = args.slice(4 - 2 * Number(shorthand))
  if (action !== "run" || (flag !== "--" && (flag !== "--class" || delimiter !== "--")) ||
    Option.isNone(purpose) || payload.length === 0) return yield* bad()
  const profile = CHECK_PROFILE[purpose.value]
  return yield* host.run(purpose.value, profile.cpuMilli, profile.memoryBytes, payload)
})

export const command = Effect.fn("HostAdmit.command")(function* (host: Host, args: ReadonlyArray<string>) {
  const [domain, ...rest] = args
  if (domain === "host" && rest[0] === "status" && rest[1] === "--json" && rest.length === 2) {
    yield* print(yield* host.hostStatus())
    return 0
  }
  if (domain === "lease") return yield* lease(host, rest)
  if (domain === "holder") return yield* holder(host, rest)
  if (domain === "check") return yield* check(host, rest)
  if (domain === "internal-attach" && Predicate.isString(rest[0]) && rest.length === 1) return yield* host.attach(rest[0])
  return yield* bad()
})

const main = Effect.fn("HostAdmit.main")(function* (args: ReadonlyArray<string>) {
  if (args[0] === "--version") {
    yield* Console.log("host-admit 1")
    return 0
  }
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    yield* Console.log(help)
    return 0
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = yield* fs.realPath(".")
  const home = yield* Config.String("HOME")
  const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.withDefault(path.join(home, ".local/state")))
  if (!path.isAbsolute(state)) return yield* bad()
  yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 })
  const root = yield* fs.realPath(state)
  const directory = path.join(root, "host-admit")
  const script = yield* path.fromFileUrl(new URL("host-admit.ts", import.meta.url))
  const [executable = "bun"] = argv
  return yield* Effect.scoped(Effect.gen(function* () {
    const host = yield* Admission.open({ cwd, directory, executable, script })
    return yield* command(host, args)
  }))
})

// Only the process entry sets an exit code; importing `command` starts no IO.
if (import.meta.main) {
  BunRuntime.runMain(main(argv.slice(2)).pipe(
    Effect.catchTag("AdmissionUnavailable", ({ reason }) => print({ version: 1, state: "refused", reason }).pipe(Effect.as(2))),
    Effect.flatMap((code) => {
      if (code === 0) return Effect.void
      return Effect.fail(code)
    }),
    Effect.provide(BunServices.layer),
  ), {
    disableErrorReporting: true,
    teardown: (result, done) => {
      if (result._tag === "Success") return done(0)
      done(Option.getOrElse(Option.filter(Cause.findErrorOption(result.cause), Predicate.isNumber), () => 1))
    },
  })
}
