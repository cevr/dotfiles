/**
 * Queue, cancel or show a session's queued model switch from a shell: what an
 * agent (or the owner) runs to queue a switch for a session it is not looking
 * at. It calls the running OpenCode service's model-next RPC, as the wakes'
 * OS jobs call theirs (mods/wake/cron/fire.ts): the service file
 * `${XDG_STATE_HOME:-~/.local/state}/opencode/service.json` names its URL and
 * password, and `POST /api/rpc/<id>/<method>?location[directory]=<dir>` with
 * `{ input }` answers `{ output }`. It never starts a service.
 *
 *   bun cmd/model-next/cli.ts queue <sessionID> <provider/model[#variant]> [--directory <dir>]
 *   bun cmd/model-next/cli.ts cancel <sessionID> [--directory <dir>]
 *   bun cmd/model-next/cli.ts show <sessionID> [--directory <dir>]
 *
 * `--directory` is any folder the service serves with the plugin loaded (it is
 * in the global config, so any of them); default the working directory. It
 * prints the answer as one JSON line and a sentence, and exits 0 when the
 * switch is queued, cancelled or shown, 1 on a refusal, 2 on a usage or
 * connection error.
 */
import path from "node:path"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Option, Schema } from "effect"
import { Answer, label, MODEL_NEXT, parseRef, refusalText, Shown } from "@dotfiles/opencode-model-next/pending"

const USAGE = "usage: bun cmd/model-next/cli.ts queue <sessionID> <provider/model[#variant]> | cancel <sessionID> | show <sessionID>  [--directory <dir>]"

const Service = Schema.Struct({ url: Schema.String, password: Schema.optional(Schema.String) })
const decodeService = Schema.decodeUnknownOption(Schema.fromJsonString(Service))
const Output = Schema.Struct({ output: Schema.Unknown })
const decodeOutput = Schema.decodeUnknownOption(Output)

const fail = (message: string, code: number): never => {
  console.error(message)
  process.exit(code)
}

const main = async (argv: ReadonlyArray<string>) => {
  const at = argv.indexOf("--directory")
  const directory = at >= 0 ? (argv[at + 1] ?? fail(USAGE, 2)) : process.cwd()
  const args = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : [...argv]
  const [method, sessionID, ref] = args
  if (sessionID === undefined || !(method === "queue" || method === "cancel" || method === "show")) return fail(USAGE, 2)
  const input: Record<string, unknown> = { sessionID }
  if (method === "queue") {
    const model = Option.getOrUndefined(parseRef(ref ?? ""))
    if (model === undefined) return fail(`not a model reference: ${ref ?? "(none)"}; write provider/model or provider/model#variant\n${USAGE}`, 2)
    input.model = model
  }
  const file = path.join(TuiDirs.dirs().state, "opencode", "service.json")
  const service = Option.getOrUndefined(decodeService(await Bun.file(file).text().catch(() => "")))
  if (service === undefined) return fail(`no OpenCode service file at ${file}: is the service running?`, 2)
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (service.password !== undefined) headers.authorization = `Basic ${btoa(`opencode:${service.password}`)}`
  const query = new URLSearchParams({ "location[directory]": path.resolve(directory) })
  const url = `${service.url.replace(/\/$/, "")}/api/rpc/${encodeURIComponent(MODEL_NEXT.id)}/${method}?${query.toString()}`
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ input }), signal: AbortSignal.timeout(30_000) }).catch((error: unknown) =>
    fail(`the service at ${service.url} did not answer: ${String(error)}`, 2),
  )
  const body: unknown = await response.json().catch(() => undefined)
  const output = Option.getOrUndefined(decodeOutput(body))?.output
  if (!response.ok || output === undefined)
    return fail(`the service answered ${response.status}${response.status === 404 ? " (is the model-next plugin loaded there?)" : ""}: ${JSON.stringify(body)}`, 2)
  console.log(JSON.stringify(output))
  if (method === "show") {
    const shown = Option.getOrUndefined(Schema.decodeUnknownOption(Shown)(output))
    console.log(shown?.pending === undefined ? "No switch queued." : `${shown.current === undefined ? "?" : label(shown.current)} → ${label(shown.pending.model)} queued.`)
    return
  }
  const answer = Option.getOrUndefined(Schema.decodeUnknownOption(Answer)(output))
  if (answer === undefined) return fail("the answer did not read", 2)
  if (answer._tag === "Refused") return fail(`Not queued: ${refusalText(answer.reason)}.`, 1)
  console.log(answer._tag === "Queued" ? `${label(answer.from)} → ${label(answer.model)} queued.` : answer.had ? "Cancelled." : "Nothing was queued.")
}

if (import.meta.main) await main(Bun.argv.slice(2))
