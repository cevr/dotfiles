/** A native test host watches files only when its test needs to observe a file change. */
interface Watching {
  readonly fileWatching: string
}

const watches = ({ fileWatching }: Watching = { fileWatching: "" }): boolean => fileWatching.trim() !== ""

/** The embedded SDK ignores the CLI's environment flags. Keep its options and the CLI policy in sync. */
export const testHostOptions = <T extends object>(options: T & { readonly fs?: { readonly fff?: boolean; readonly filewatcher?: never } }, need?: Watching) => ({
  ...options,
  fs: { ...options.fs, filewatcher: watches(need) },
})

/** Overlay last so the host cannot accidentally inherit the caller's watcher setting. */
export const testHostEnv = (need?: Watching) => {
  const disabled = Number(!watches(need)).toString()
  return { OPENCODE_FILEWATCHER_DISABLE: disabled, OPENCODE_DISABLE_FILEWATCHER: disabled }
}
