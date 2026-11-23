import { argv } from "bun"
import { runOwnedHost } from "../../testbeds/gamut/pty-host.ts"
import { scratchInput } from "../read-path.ts"
import { scratchPtyCommand, scratchPtyEnv } from "../scratch-child.ts"

const dir = scratchInput(argv[2] || "")
void runOwnedHost({
  socket: scratchInput(`${dir}/host.sock`), cwd: dir, command: scratchPtyCommand("sleep 600; :", dir),
  env: scratchPtyEnv(dir), cols: 60, rows: 12,
})
