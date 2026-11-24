// `workrift processes` on a real Linux /proc: proc-walk-linux.sh in a Lima VM, the Linux leg of the subvolume
// switch's walk (the Mac's tests run it on a /proc of the bench). WORKRIFT_LIMA names the VM (wbnoble: Ubuntu
// 24.04, sudo -n, setpriv); without it the leg is skipped, named. One VM at a time, outside the lease, at nice 10.
import { expect, test } from "bun:test"
import { join } from "node:path"
import { hangGuard } from "../../opencode/tests/hang-guard.ts"

const vm = process.env.WORKRIFT_LIMA ?? ""
const here = import.meta.dir
const run = (argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" })
  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

test.skipIf(vm === "")("on a Linux VM: unread processes of this user's own uid, processes ending mid-walk and a failed walk", () => {
  const dir = `/tmp/proc-walk-run-${process.pid}`
  expect(run(["limactl", "shell", vm, "mkdir", "-p", dir]).code).toBe(0)
  for (const [from, to] of [
    [join(here, "..", "bin", "workrift"), "workrift"],
    [join(here, "proc-walk-linux.sh"), "proc-walk-linux.sh"],
  ] as const) {
    const copied = run(["limactl", "copy", from, `${vm}:${dir}/${to}`])
    expect(copied.code, copied.err).toBe(0)
  }
  const ran = run(["limactl", "shell", vm, "nice", "-n", "10", "sh", `${dir}/proc-walk-linux.sh`, `${dir}/workrift`])
  run(["limactl", "shell", vm, "rm", "-rf", dir])
  const lines = ran.out.split("\n").filter((line) => /^(PASS|FAIL) /.test(line))
  expect(lines.filter((line) => line.startsWith("FAIL")), ran.out + ran.err).toEqual([])
  // (a) reproduced and judged four ways, (b), (d), (e) and (g) reproduced and named, (h) reproduced and judged three ways, (f) two ways, (c).
  expect(lines.length, ran.out).toBe(19)
  expect(ran.code).toBe(0)
}, hangGuard("process-fixture"))
