// The Host's pending-prompt actions (tui/host.ts openPending): a queued row's
// click opens the host's select dialog with what the host's own pending rows
// offer for its kind (`pendingActions`: a steer `Move to queue` or `Delete`, a
// queued prompt `Send now` or `Delete`), sent over the session inbox's routes.
// The host's data drops or moves the row once its inbox event arrives.
import type { Plugin } from "@opencode/plugin/tui"
import { pendingActions, type WaitingPrompt } from "../pending.ts"

export async function openPending(context: Plugin.Context, sessionID: string, prompt: WaitingPrompt): Promise<void> {
  const picked = await context.ui.dialog.select({
    title: prompt.delivery === "steer" ? "Queued prompt" : "Prompt after the turn",
    options: pendingActions(prompt.delivery).map((action) => ({ ...action })),
  })
  if (picked === undefined) return
  const inbox = context.client.session.inbox
  const inboxID = prompt.id
  const request =
    picked === "cancel" ? inbox.cancel({ sessionID, inboxID }) : inbox.update({ sessionID, inboxID, delivery: picked })
  const verb = picked === "cancel" ? "delete" : picked === "queue" ? "move" : "send"
  await request.catch((error: unknown) =>
    context.ui.toast.show({
      message: `Could not ${verb} the prompt: ${error instanceof Error ? error.message : String(error)}`,
      variant: "error",
    }),
  )
}
