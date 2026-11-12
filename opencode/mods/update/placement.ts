import { Option, Schema } from "effect"

/**
 * Where the OpenCode service runs among the user's processes. On a host whose user processes a user
 * systemd manages (the workbox), every client starts the service from its own cgroup: a TUI's
 * reconnect from its herdr pane, the launcher's restart from wherever it ran. There the service then
 * shares one CPU weight with every TUI and every job it starts (perf-load H5). So the service places
 * itself: as its plugins load, it asks the user manager for a scope of its own, `opencode-service-<pid>.scope`
 * in `app.slice`, at `CPUWeight=1000` (the TUIs' herdr unit and the jobs' units stay at 100, the
 * heavy commands' scopes at 20), with its process in it. Its later children start there too.
 *
 * Why not a fixed `opencode.service` the launcher restarts with systemctl: the fork's clients start
 * the service themselves (`Service.ensure`, the install record's command), and a TUI that sees the
 * service go retries its own start every 100 ms, so after a `systemctl restart` a TUI's start
 * usually wins the port and the service lands outside the unit. Self-placement holds for every start.
 */
export const Placement = Schema.TaggedUnion({
  /** The service runs in its own scope, `unit`. */
  Placed: { unit: Schema.String },
  /** A user manager runs above the service and it is not in its scope: where it runs, and why. */
  Unplaced: { cgroup: Schema.String, cause: Schema.String },
  /** No user systemd manages this process (the Mac, or a Linux without one): nothing to place. */
  Unmanaged: { reason: Schema.String },
})
export type Placement = typeof Placement.Type

/** The service's CPU and I/O weight: ten times the default 100 the TUIs and the jobs run at. */
export const SERVICE_WEIGHT = 1000

/** The scope a service process `pid` places itself in. */
export const scopeName = (pid: number): string => `opencode-service-${pid}.scope`

/**
 * The call that asks the user manager for the scope with `pid` in it (`StartTransientUnit`, mode
 * `fail`): in `app.slice`, at the service's CPU and I/O weight, collected once it is empty.
 */
export const placeArgv = (pid: number): ReadonlyArray<string> => [
  "busctl",
  "--user",
  "call",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "StartTransientUnit",
  "ssa(sv)a(sa(sv))",
  scopeName(pid),
  "fail",
  "6",
  "Description",
  "s",
  "OpenCode service (dotfiles opencode/mods/update/placement.ts)",
  "PIDs",
  "au",
  "1",
  String(pid),
  "Slice",
  "s",
  "app.slice",
  "CPUWeight",
  "t",
  String(SERVICE_WEIGHT),
  "IOWeight",
  "t",
  String(SERVICE_WEIGHT),
  "CollectMode",
  "s",
  "inactive-or-failed",
  "0",
]

/** The cgroup v2 path in a `/proc/<pid>/cgroup` text (its `0::` line); none when it has none. */
export const cgroupOf = (text: string): Option.Option<string> =>
  Option.fromNullishOr(text.split("\n").find((line) => line.startsWith("0::"))).pipe(Option.map((line) => line.slice("0::".length).trim()))

/**
 * Where process `pid` runs, judged from its cgroup text: placed in its own scope; unplaced under the
 * user's logind slice (`user.slice`), where the user manager can take it in from a herdr unit and an
 * SSH session alike (`cause` says why it did not, when the caller knows); else unmanaged.
 */
export const placementOf = (pid: number, text: string, cause = "it was not placed"): Placement =>
  Option.match(cgroupOf(text), {
    onNone: () => Placement.cases.Unmanaged.make({ reason: "no cgroup v2 path" }),
    onSome: (cgroup) => {
      if (cgroup.split("/").at(-1) === scopeName(pid)) return Placement.cases.Placed.make({ unit: scopeName(pid) })
      if (!cgroup.startsWith("/user.slice/")) return Placement.cases.Unmanaged.make({ reason: `no user systemd manages ${cgroup}` })
      return Placement.cases.Unplaced.make({ cgroup, cause })
    },
  })

/** How a placement reads in the update's log and its health. */
export const describePlacement = (placement: Placement): string =>
  Placement.match(placement, {
    Placed: (placed) => `in ${placed.unit} at CPUWeight=${SERVICE_WEIGHT}`,
    Unplaced: (unplaced) => `outside its scope, in ${unplaced.cgroup}: ${unplaced.cause}`,
    Unmanaged: (unmanaged) => `not placed: ${unmanaged.reason}`,
  })
