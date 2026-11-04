// The installed-command seam: a fake `codex-bridge ensure` in an isolated
// HOME supplies a fake Unix-socket daemon. Never invokes Codex or the real CLI.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("Codex ensures the daemon once and does not replay an HTTP-refused start", async () => {
  const base = mkdtempSync(join(tmpdir(), "bridge-transport-"))
  const socket = join(base, "bridge.sock")
  const marker = join(base, "ensured")
  const bin = join(base, ".local/bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "codex-bridge"), `#!${process.execPath}\nif (process.argv[2] !== "ensure") process.exit(2);\n(await import("node:fs")).appendFileSync(${JSON.stringify(marker)}, "ensured");\nconsole.log(JSON.stringify({ socket: ${JSON.stringify(socket)} }));\n`, { mode: 0o755 })
  const paths: string[] = []
  const server = Bun.serve({ unix: socket, fetch(request) {
    paths.push(new URL(request.url).pathname)
    return Response.json({ error: "budget refuses start" }, { status: 409 })
  } })
  try {
    const source = join(import.meta.dir, "../plugins/codex/src/bridge.ts")
    const code = `import { Bridge } from ${JSON.stringify(source)};
const bridge = new Bridge();
for (let i = 0; i < 2; i++) {
  try { await bridge.call("POST", "/start", { description: "fixture" }); process.exit(3); }
  catch (error) { if (error.message !== "budget refuses start") throw error; }
}`
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: { HOME: base, PATH: "/bin:/usr/bin" }, stdout: "pipe", stderr: "pipe",
    })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    expect(readFileSync(marker, "utf8")).toBe("ensured")
    expect(paths).toEqual(["/start", "/start"])
  } finally {
    server.stop(true)
    rmSync(base, { recursive: true, force: true })
  }
})
