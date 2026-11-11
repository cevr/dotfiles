// The program the fleet's claimer runs over SSH (`bun run -`, this file on its
// stdin, after a line that sets `globalThis.POOL_CLAIM` to the claim) to work
// a claim the owner said yes to on another host: it reads the local OpenCode
// server's service file (`OPENCODE_SERVICE_FILE` names another one), asks the
// pool plugin's `claimFor` RPC on loopback, and prints the answer. The
// password never leaves the host; a claim names a reset, never a token.
// It imports nothing, so a peer needs only Bun.
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE ?? `${process.env.HOME ?? ""}/.local/state/opencode/service.json`
const ROUTE = "/api/rpc/dotfiles-opencode.pool/claimFor"

const fail = (message: string) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const main = async () => {
  const claim: unknown = (globalThis as { POOL_CLAIM?: unknown }).POOL_CLAIM
  if (!isRecord(claim)) return fail("no claim to work")
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
    body: JSON.stringify({ input: claim }),
    // A claim reads the account and claims: longer than a report.
    signal: AbortSignal.timeout(40_000),
  }).catch((error: unknown) => fail(`the OpenCode server does not answer: ${String(error)}`))
  if (response === undefined) return
  if (!response.ok) return fail(`the pool's claimFor answered ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body) || !("output" in body)) return fail("the pool's claimFor answered no output")
  process.stdout.write(JSON.stringify(body.output))
}

await main()
