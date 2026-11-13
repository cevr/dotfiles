// Faults a test puts into the host: what the real host may do outside its
// contract, so a generated property can ask what a plugin does then. No law
// holds a fault to real OpenCode; each is named here with what it stands for.
//
// - A storage write that fails: the fork's plugin storage is a table in the
//   global database (packages/core/src/plugin/host.ts `storage`), whose
//   writes do not fail by contract; a full disk or a locked database makes one
//   die. `failWrites(plugin, count, after)` lets that plugin's next `after`
//   writes (`storage.set`) through, then makes `count` die, the value not
//   stored.

/** The faults of one host. */
export const make = () => {
  const writes = new Map<string, { after: number; count: number }>()
  return {
    /** After `after` more writes of `plugin`'s storage go through, the next `count` die. */
    failWrites: (plugin: string, count: number, after = 0) => {
      writes.set(plugin, { after, count })
    },
    /** Whether this write of `plugin`'s storage dies; it counts one off. */
    takeWrite: (plugin: string) => {
      const planned = writes.get(plugin) ?? { after: 0, count: 0 }
      if (planned.after > 0) {
        planned.after -= 1
        return false
      }
      if (planned.count <= 0) return false
      planned.count -= 1
      return true
    },
  }
}

export type Faults = ReturnType<typeof make>
