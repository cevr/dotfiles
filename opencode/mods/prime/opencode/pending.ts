// The Host's pending-prompt actions (tui/host.ts openPending): a queued row's
// click opens the host's select dialog with what the host's own pending-steer
// row offers, `Move to queue` and `Delete`, sent over the session inbox's
// routes. The host's data drops the row once its inbox event arrives.
import type { Plugin } from "@opencode/plugin/tui"

export async function openPending(context: Plugin.Context, sessionID: string, inboxID: string): Promise<void> {
  const picked = await context.ui.dialog.select({
    title: "Queued prompt",
    options: [
      { title: "Move to queue", value: "queue" as const, description: "after the turn, not at its next step" },
      { title: "Delete", value: "cancel" as const },
    ],
  })
  if (picked === undefined) return
  const inbox = context.client.session.inbox
  const request =
    picked === "queue" ? inbox.update({ sessionID, inboxID, delivery: "queue" }) : inbox.cancel({ sessionID, inboxID })
  await request.catch((error: unknown) =>
    context.ui.toast.show({
      message: `Could not ${picked === "queue" ? "move" : "delete"} the prompt: ${error instanceof Error ? error.message : String(error)}`,
      variant: "error",
    }),
  )
}
