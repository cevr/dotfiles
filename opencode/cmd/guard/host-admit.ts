#!/usr/bin/env bun
import { argv, env, stdin } from "bun"
import { Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { AdmissionUnavailable } from "@dotfiles/opencode-guard/admission"
import { Counter, OpaqueId, Purpose, qualifiedForm, Request, Width } from "@dotfiles/opencode-guard/admission-wire"
import { checkModel, joinWidth, readWidth } from "@dotfiles/opencode-guard/check-demand"
import { parseArgv } from "@dotfiles/opencode-guard/command-line"
import { Holder } from "@dotfiles/opencode-guard/host-resources"
import { admissionPurpose } from "@dotfiles/opencode-guard/launcher"
import { type ForegroundInterrupt } from "@dotfiles/opencode-guard/process/terminal"
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

const submit = Effect.fn("HostAdmit.submit")(function* (host: Host) {
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
})

const lease = Effect.fn("HostAdmit.lease")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, flag, value, suffix, ...rest] = args
  if (action === "request" && flag === "--json" && args.length === 2) return yield* submit(host)
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

const widthHint = (value: string) => {
  if (value === "full") return Effect.succeed("full" as const)
  const width = readWidth(value)
  if (width === "invalid" || (width === "unknown" && value !== "unknown"))
    return Effect.fail(new AdmissionUnavailable({ reason: "invalid-width" }))
  return Effect.succeed(width)
}
export const checkSpec = Effect.fn("HostAdmit.checkSpec")(function* (payload: ReadonlyArray<string>, options: ReadonlyArray<string>, enforced: boolean) {
  const command = parseArgv(payload, env)
  const inferred = admissionPurpose(command)
  let purpose = purposeOf(inferred)
  let hint = Option.none<Effect.Success<ReturnType<typeof widthHint>>>()
  const seen = new Set<string>()
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i] ?? ""
    const value = options[i + 1] ?? ""
    if (seen.has(flag)) return yield* bad()
    seen.add(flag)
    if (flag === "--class") purpose = purposeOf(value)
    else if (flag === "--width") hint = Option.some(yield* widthHint(value))
    else return yield* bad()
  }
  if (Option.isNone(purpose)) return yield* new AdmissionUnavailable({ reason: "unsupported-class" })
  if (inferred !== "check" && purpose.value !== inferred) return yield* bad()
  if (enforced && Option.isSome(hint) && Predicate.isNumber(hint.value))
    return { purpose: purpose.value, width: hint.value, imposed: true, advice: "The Linux CPU controller enforces the declared width." }
  const model = checkModel(command)
  const width = joinWidth(model.width, Option.getOrElse(hint, () => model.width))
  if (width === "invalid") return yield* new AdmissionUnavailable({ reason: "invalid-width" })
  return { purpose: purpose.value, width, imposed: false, advice: model.advice }
})

const check = Effect.fn("HostAdmit.check")(function* (host: Host, args: ReadonlyArray<string>) {
  const [action, ...rest] = args
  const delimiter = rest.indexOf("--")
  const payload = rest.slice(delimiter + 1)
  if (action !== "run" || delimiter < 0 || payload.length === 0 || delimiter % 2 !== 0) return yield* bad()
  const demand = yield* checkSpec(payload, rest.slice(0, delimiter), yield* host.enforcedWidth)
  return yield* host.run(demand, payload, demand.advice, demand.imposed)
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

type Ports = Pick<Admission.Config, "sample" | "beforeResume">
const main = Effect.fn("HostAdmit.main")(function* (
  args: ReadonlyArray<string>, onInterrupt: (handler: Option.Option<ForegroundInterrupt>) => void, ports: Ports,
) {
  if (args[0] === "--test-supply") return yield* bad()
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
  const script = yield* path.fromFileUrl(new URL("host-admit.ts", import.meta.url)).pipe(Effect.mapError(bad))
  const [executable = "bun"] = argv
  return yield* Effect.scoped(Effect.gen(function* () {
    const host = yield* Admission.open({ cwd, directory, executable, script, onInterrupt, ...ports })
    return yield* command(host, args)
  }))
})

// Only the process entry sets an exit code; importing `command` starts no IO.
export const runProcessMain = (args: ReadonlyArray<string>, ports: Ports = {}) => {
  let foreground = Option.none<ForegroundInterrupt>()
  let interrupted = 1
  const task = Effect.runFork(main(args, (handler) => { foreground = handler }, ports).pipe(
    Effect.catchTag("AdmissionUnavailable", ({ reason, storeVersion, detail }) => print({
      version: 1, state: "refused", reason, qualifiedForm: qualifiedForm(reason, storeVersion),
      ...Option.match(Option.fromNullishOr(detail), { onNone: () => ({}), onSome: (cause) => ({ detail: cause }) }),
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
    if (!Option.exists(foreground, (handle) => handle())) end(130)
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
if (import.meta.main) runProcessMain(argv.slice(2))
