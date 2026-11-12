// The program a peer runs over SSH (`bun run -`, this file on its stdin,
// after a line that sets `globalThis.POOL_PUSH` to a push request, push.ts)
// to start, end, plan or read a push on that host: it reads the local
// OpenCode server's service file (`OPENCODE_SERVICE_FILE` names another
// one), asks the pool plugin's `push` RPC on loopback, and prints the answer.
// The password never leaves the host; a push request names a goal, a scope
// and resets, never a token.
// It imports nothing, so a peer needs only Bun.
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE ?? `${process.env.HOME ?? ""}/.local/state/opencode/service.json`
const ROUTE = "/api/rpc/dotfiles-opencode.pool/push"

const fail = (message: string) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const main = async () => {
  const request: unknown = (globalThis as { POOL_PUSH?: unknown }).POOL_PUSH
  if (!isRecord(request)) return fail("no push request")
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
    body: JSON.stringify({ input: request }),
    signal: AbortSignal.timeout(20_000),
  }).catch((error: unknown) => fail(`the OpenCode server does not answer: ${String(error)}`))
  if (response === undefined) return
  if (!response.ok) return fail(`the pool's push answered ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || !("output" in body)) return fail("the pool's push answered no output")
  process.stdout.write(JSON.stringify(body.output))
}

await main()
