#!/usr/bin/env bun
import { argv, env, stdin } from "bun"
import { Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AdmissionUnavailable } from "@dotfiles/opencode-guard/admission"
import { Counter, OpaqueId, Purpose, qualifiedForm, Request, Width } from "@dotfiles/opencode-guard/admission-wire"
import { argvWidth, joinWidth, readWidth } from "@dotfiles/opencode-guard/check-demand"
import { Holder } from "@dotfiles/opencode-guard/host-resources"
import { argvPurpose } from "@dotfiles/opencode-guard/launcher"
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
  check run [--class check|land-check|vm|inventory|exclusive-check] [--width N|full|unknown] -- COMMAND [ARGS...]
`

const bad = () => new AdmissionUnavailable({ reason: "invalid-request" })
const output = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const print = (value: Schema.Json) => Console.log(output(value))
const address = Schema.decodeUnknownOption(OpaqueId)
const count = Schema.decodeUnknownOption(Counter)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))
const requestOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))
const peek = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  purpose: Schema.String, demand: Schema.Struct({ width: Schema.optionalKey(Schema.Unknown) }),
})))
const validWidth = Schema.decodeUnknownOption(Width)
const purposeOf = Schema.decodeUnknownOption(Purpose)
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
  return yield* Effect.acquireUseRelease(
    Effect.try({ try: () => stdin.stream().getReader(), catch: bad }),
    (reader) => Effect.gen(function* () {
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let bytes = 0
      let text = ""
      for (;;) {
        const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: bad })
        if (chunk.done) return text + (yield* Effect.try({ try: () => decoder.decode(), catch: bad }))
        bytes += chunk.value.byteLength
        if (bytes > 262_144) return yield* bad()
        text += yield* Effect.try({ try: () => decoder.decode(chunk.value, { stream: true }), catch: bad })
      }
    }),
    (reader) => Effect.tryPromise({ try: () => reader.cancel(), catch: bad }).pipe(Effect.ignore),
  )
})

type Host = Effect.Success<ReturnType<typeof Admission.open>>
const refused = (reply: { readonly state: string }) => 2 * Number(reply.state === "refused")

const lease = Effect.fn("HostAdmit.lease")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, flag, value, suffix, ...rest] = args
  if (action === "request" && flag === "--json" && args.length === 2) {
    const text = yield* read()
    if (!uniqueKeys(text)) return yield* bad()
    const header = peek(text)
    if (Option.isSome(header)) {
      if (Option.isNone(purposeOf(header.value.purpose))) return yield* new AdmissionUnavailable({ reason: "unsupported-class" })
      if ("width" in header.value.demand && Option.isNone(validWidth(header.value.demand.width)))
        return yield* new AdmissionUnavailable({ reason: "invalid-width" })
    }
    const request = yield* requestOf(text).pipe(Effect.mapError(bad))
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

const check = Effect.fn("HostAdmit.check")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, ...rest] = args
  const delimiter = rest.indexOf("--")
  const payload = rest.slice(delimiter + 1)
  if (action !== "run" || delimiter < 0 || payload.length === 0 || delimiter % 2 !== 0) return yield* bad()
  const inferred = argvPurpose(payload)
  let purpose = purposeOf(inferred)
  let width = argvWidth(payload, env)
  const seen = new Set<string>()
  for (let i = 0; i < delimiter; i += 2) {
    const flag = rest[i] ?? ""
    const value = rest[i + 1] ?? ""
    if (seen.has(flag)) return yield* bad()
    seen.add(flag)
    if (flag === "--class") purpose = purposeOf(value)
    else if (flag === "--width") {
      let hint = readWidth(value)
      if (value === "full") hint = "full"
      if (hint === "invalid" || (hint === "unknown" && value !== "unknown"))
        return yield* new AdmissionUnavailable({ reason: "invalid-width" })
      width = joinWidth(width, hint)
    } else return yield* bad()
  }
  if (Option.isNone(purpose)) return yield* new AdmissionUnavailable({ reason: "unsupported-class" })
  if (inferred !== "check" && purpose.value !== inferred) return yield* bad()
  if (width === "invalid") return yield* new AdmissionUnavailable({ reason: "invalid-width" })
  return yield* host.run({ purpose: purpose.value, width }, payload)
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

const main = Effect.fn("HostAdmit.main")(function* (args: ReadonlyArray<string>, onForeground: (owned: boolean) => void) {
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
    const host = yield* Admission.open({ cwd, directory, executable, script, onForeground })
    return yield* command(host, args)
  }))
})

// Only the process entry sets an exit code; importing `command` starts no IO.
if (import.meta.main) {
  let foreground = false
  let interrupted = 1
  const task = Effect.runFork(main(argv.slice(2), (owned) => { foreground = owned }).pipe(
    Effect.catchTag("AdmissionUnavailable", ({ reason }) => print({
      version: 1, state: "refused", reason, qualifiedForm: qualifiedForm(reason),
    }).pipe(Effect.as(2))),
    Effect.provide(BunServices.layer),
  ))
  const end = (status: number) => {
    if (interrupted === 1) interrupted = status
    task.interruptUnsafe(task.id)
  }
  const terminate = () => end(143)
  const interrupt = () => {
    // The terminal already sent SIGINT to every member of the owned group.
    // Reap the payload's real exit before closing the inherited descriptor.
    if (!foreground) end(130)
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  task.addObserver((result) => {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    if (result._tag === "Success") process.exitCode = result.value
    else process.exitCode = interrupted
  })
}
