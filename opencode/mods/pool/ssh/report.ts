// The program a peer runs over SSH (`bun run -`, this file on its stdin) to
// answer the pool's report: it reads the local OpenCode server's service file
// (its URL and password; `OPENCODE_SERVICE_FILE` names another one), asks the
// pool plugin's `report` RPC on loopback, and prints the server's answer whole:
// the report under `output`, or the RPC error a refusal carries, which the
// reading host decodes and names (peers.ts). The password never leaves the
// host; only the answer does, and a report carries no token.
// It imports nothing, so a peer needs only Bun.
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE ?? `${process.env.HOME ?? ""}/.local/state/opencode/service.json`
const ROUTE = "/api/rpc/dotfiles-opencode.pool/report"

const fail = (message: string) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const main = async () => {
  const file = Bun.file(SERVICE_FILE)
  if (!(await file.exists())) return fail(`no OpenCode server: ${SERVICE_FILE} is missing`)
  const service: unknown = await file.json().catch(() => undefined)
  if (!isRecord(service) || typeof service.url !== "string" || typeof service.password !== "string")
    return fail(`${SERVICE_FILE} names no server`)
  const response = await fetch(new URL(ROUTE, service.url), {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`opencode:${service.password}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(8_000),
  }).catch((error: unknown) => fail(`the OpenCode server does not answer: ${String(error)}`))
  if (response === undefined) return
  const body: unknown = await response.json().catch(() => null)
  process.stdout.write(JSON.stringify(body))
  if (!response.ok) return fail(`the pool's report answered ${response.status}`)
}

await main()
