export const heavyJob = (requested: boolean, classified: boolean) => requested || classified

/** A literal shell payload; the owning process adapter attaches launch policy. */
export const jobArgv = (command: string): ReadonlyArray<string> => ["/bin/sh", "-c", command]
