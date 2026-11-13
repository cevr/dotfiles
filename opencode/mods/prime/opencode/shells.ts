// The Host's shell list (tui/host.ts openShells): the session's shell
// commands, running and recently ended, in the host's select dialog, read
// fresh from the host's shell routes each time it opens. ctrl+k kills the
// highlighted running command and lists again; Enter shows its output's tail,
// and closing that returns to the list. The words are ../shells.ts.
import * as TuiClock from "@dotfiles/decider/tui-clock"
import type { Plugin } from "@opencode/plugin/tui"
import { sessionShells, shellOption, shellTitle, type ShellEntry } from "../shells.ts"

/** How many bytes of each command's output the list reads for its last line. */
const TAIL_BYTES = 4096
/** How many bytes the output view shows. */
const VIEW_BYTES = 16_384

async function tail(context: Plugin.Context, id: string, bytes: number) {
  const location = context.location
  const end = await context.client.shell.output({ id, location, cursor: Number.MAX_SAFE_INTEGER })
  const page = await context.client.shell.output({
    id,
    location,
    cursor: Math.max(0, end.data.size - bytes),
    limit: bytes,
  })
  return { output: page.data.output, cut: end.data.size > bytes }
}

/** The tail of a command's output a panel row reads its last line from; empty when it does not read. */
export const shellTail = (context: Plugin.Context, id: string): Promise<string> =>
  tail(context, id, TAIL_BYTES).then(
    (read) => read.output,
    () => "",
  )

export async function openShells(context: Plugin.Context, sessionID: string, current?: string): Promise<void> {
  const location = context.location
  const listed: ReadonlyArray<ShellEntry> = await context.client.shell
    .list({ location, exited: true })
    .then((response) => response.data, () => [])
  const shells = sessionShells(listed, sessionID)
  const outputs = await Promise.all(
    shells.map((shell) =>
      tail(context, shell.id, TAIL_BYTES).then(
        (read) => read.output,
        () => undefined,
      ),
    ),
  )
  const now = TuiClock.now()
  const running = new Set(shells.filter((shell) => shell.status === "running").map((shell) => shell.id))
  const picked = await context.ui.dialog.select({
    title: shells.length === 0 ? "Shells · none in this session" : "Shells",
    placeholder: "Filter",
    options: shells.map((shell, index) => shellOption(shell, now, outputs[index])),
    current,
    actions: [
      {
        bind: "ctrl+k",
        title: "kill",
        onTrigger: (id: string) => {
          if (!running.has(id)) return
          void context.client.shell
            .kill({ id, location })
            .catch(() => undefined)
            .then(() => openShells(context, sessionID, id))
        },
      },
    ],
  })
  // Undefined: closed, or replaced by the list a kill opened.
  if (picked === undefined) return
  const shell = shells.find((each) => each.id === picked)
  if (!shell) return
  const read = await tail(context, picked, VIEW_BYTES).catch(() => undefined)
  const body = read === undefined ? "Its output is no longer available." : read.output.trimEnd() || "(no output yet)"
  await context.ui.dialog.alert({
    title: `${shellTitle(shell)} · ${shell.id}`,
    message: read?.cut ? `…\n${body}` : body,
  })
  return openShells(context, sessionID, picked)
}
