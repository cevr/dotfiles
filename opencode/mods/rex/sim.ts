// An iOS simulator mirrored in the showcase pane: the viewer screenshots a
// booted simulator every few seconds (read only: it never boots, shuts down,
// installs or erases one) and draws the screen again only when it changed.
// Which simulator: the one asked for by name or udid, else the one used
// last of those booted. The simulator runs only on a Mac: from another host
// the viewer reaches the Mac with `ssh` (`REX_SHOW_SIM_HOST`).
import { Array as Arr, Data, Option, Order } from "effect"

/** How often the simulator is screenshot by default, in seconds. */
export const SIM_EVERY = 1

/** A booted simulator, as `simctl list` gives it. */
export interface Device {
  readonly udid: string
  readonly name: string
  /** Its runtime, as `iOS 27.0`. */
  readonly os: string
  /** When it was used last (ISO time), as the stand-in for when it was booted. */
  readonly used: string
}

/** Which simulator the viewer mirrors, or why none. */
export type Choice = Data.TaggedEnum<{
  Chosen: { readonly device: Device }
  NoneBooted: {}
  NotBooted: { readonly wanted: string; readonly booted: ReadonlyArray<string> }
}>
export const Choice = Data.taggedEnum<Choice>()

const lastUsedFirst = Order.flip(Order.mapInput(Order.String, (device: Device) => device.used))

/** The simulator `wanted` names (its udid, or its name in any case) among `booted`; else the one used last; else why none. */
export const choose = (booted: ReadonlyArray<Device>, wanted: Option.Option<string>): Choice =>
  Option.match(wanted, {
    onNone: () =>
      Option.match(Arr.head(Arr.sort(booted, lastUsedFirst)), {
        onNone: () => Choice.NoneBooted(),
        onSome: (device) => Choice.Chosen({ device }),
      }),
    onSome: (name) =>
      Option.match(
        Arr.findFirst(booted, (device) => device.udid.toLowerCase() === name.toLowerCase() || device.name.toLowerCase() === name.toLowerCase()),
        {
          onNone: () => Choice.NotBooted({ wanted: name, booted: booted.map((device) => device.name) }),
          onSome: (device) => Choice.Chosen({ device }),
        },
      ),
  })

/** What the pane says when no simulator can be mirrored. */
export const whyNone = (choice: Choice): Option.Option<string> =>
  Choice.$match(choice, {
    Chosen: () => Option.none(),
    NoneBooted: () => Option.some("no iOS simulator is booted: boot one in Xcode or Simulator (rex-show never boots one)"),
    NotBooted: ({ wanted, booted }) =>
      Option.some(
        `no booted simulator named ${wanted}; booted: ${Option.match(Option.liftPredicate(booted, (names) => names.length > 0), { onNone: () => "none", onSome: (names) => names.join(", ") })}`,
      ),
  })

/** A runtime id as people say it: `com.apple.CoreSimulator.SimRuntime.iOS-27-0` is `iOS 27.0`. */
export const osOf = (runtime: string): string =>
  Option.match(Option.fromNullishOr(/SimRuntime\.([A-Za-z]+)-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime)), {
    onNone: () => runtime,
    onSome: ([, family, major, minor, patch]) => `${family} ${[major, minor, ...Option.toArray(Option.fromUndefinedOr(patch))].join(".")}`,
  })

/** Whether `text` is a simulator udid, safe to hand to a shell on the Mac. */
export const isUdid = (text: string): boolean => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(text)
