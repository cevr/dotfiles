/** The named host events with lifecycle meaning, not opaque continuity positions. */
export const lifecycleEventTypes = [
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.failed", "session.retry.scheduled", "session.deleted",
  "session.created", "session.revert.committed",
  "shell.created", "shell.exited", "shell.deleted", "experimental.job.updated",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled",
  "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
] as const
