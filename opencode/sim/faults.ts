// Faults a test puts into the host: what the real host may do outside its
// contract, so a generated property can ask what a plugin does then. No law
// holds a fault to real OpenCode; each is named here with what it stands for.
//
// - A storage write that fails: the fork's plugin storage is a table in the
//   global database (packages/core/src/plugin/host.ts `storage`), whose
//   writes do not fail by contract; a full disk or a locked database makes one
//   die. `failWrites(plugin, n)` makes that plugin's next `n` writes
//   (`storage.set`) die, the value not stored.

/** The faults of one host. */
export const make = () => {
  const writes = new Map<string, number>()
  return {
    /** The next `count` writes of `plugin`'s storage die. */
    failWrites: (plugin: string, count: number) => {
      writes.set(plugin, count)
    },
    /** Whether this write of `plugin`'s storage dies; it counts one off. */
    takeWrite: (plugin: string) => {
      const left = writes.get(plugin) ?? 0
      if (left <= 0) return false
      writes.set(plugin, left - 1)
      return true
    },
    /** How many writes of `plugin` are still to die. */
    writesLeft: (plugin: string) => writes.get(plugin) ?? 0,
  }
}

export type Faults = ReturnType<typeof make>
