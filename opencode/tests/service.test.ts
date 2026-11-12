// `ready` against a stand-in for the fork's background service that answers
// as the fork's `ServerProcess` does (packages/server/src/process.ts
// `dispatch`): its file is written when it listens, then every route answers
// 503 `service_starting` with `retry-after: 1` and `/api/info` 503 until the
// boot ends, ready (200) or failed (`/api/info` 500, the rest 503
// `service_failed`). Under load the fork's boot takes seconds after its file
// appears; here the stand-in stays starting until the test ends its boot.
import { afterAll, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ready } from "./service.ts"
import { scratch } from "./scratch.ts"

const root = scratch("service-ready-").path
const servers: Array<{ stop: (force: boolean) => unknown }> = []
afterAll(() => {
  for (const server of servers) server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

type State = "starting" | "ready" | "failed"

/** A stand-in service that writes `file` once it listens, and starts in `starting`. */
const standIn = (file: string) => {
  const password = "stand-in-password"
  let state: State = "starting"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`) return new Response("unauthorized", { status: 401 })
      const path = new URL(request.url).pathname
      if (path === "/api/info")
        return Response.json({ version: "local", pid: process.pid, urls: [] }, { status: state === "ready" ? 200 : state === "failed" ? 500 : 503, headers: state === "starting" ? { "retry-after": "1" } : {} })
      if (state === "ready") return Response.json({ data: [] })
      if (state === "failed") return Response.json({ code: "service_failed" }, { status: 503 })
      return Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
    },
  })
  servers.push(server)
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, password, pid: process.pid }))
  return { boot: (to: State) => (state = to) }
}

const auth = (password: string) => ({ authorization: `Basic ${btoa(`opencode:${password}`)}` })

describe("a test's service is ready once it can serve, not once its file is written", () => {
  test("while the service boots it waits, and the service it returns answers a call", async () => {
    const file = join(root, "booting.json")
    const service = standIn(file)
    const pending = ready(file, () => "stand-in")
    // The boot still runs a second after the file appeared: the service is not returned yet.
    expect(await Promise.race([pending.then(() => "returned"), Bun.sleep(1000).then(() => "waiting")])).toBe("waiting")
    service.boot("ready")
    const { url, password } = await pending
    const call = await fetch(new URL("/api/session", url), { headers: auth(password) })
    expect(call.status).toBe(200)
  })

  test("a boot that failed is named at once, not waited out to the deadline", async () => {
    const file = join(root, "failed.json")
    standIn(file).boot("failed")
    const started = Date.now()
    await expect(ready(file, () => "stand-in", 30_000)).rejects.toThrow("stand-in: the service failed to start (/api/info answered 500)")
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
