export const heavyJob = (requested: boolean, classified: boolean) => requested || classified

/** The durable supervisor owns this launch. The nested helper owns all
 * queue/claim/containment work, and it is the only process that can exec argv. */
export const jobArgv = (helper: ReadonlyArray<string>, command: string, admission?: string) => {
  const argv = ["/bin/sh", "-c", command]
  if (!admission) return argv
  return [...helper, "check", "run", "--class", admission, "--", ...argv]
}
