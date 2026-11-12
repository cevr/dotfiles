/**
 * Three-way merges of `effect-debt.json` and `.oxlintrc.effect-debt.json` by key, never by line,
 * for the git merge driver `effect-debt` (`.gitattributes`, `bun scripts/effect-debt.ts --merge`).
 *
 * Parallel units each tighten budgets and add exemptions; a line merge of the two files conflicts
 * whenever two edits sit on neighbouring lines. Here each value merges on its own key: a list of
 * names or exemptions as a keyed set (an entry either side added is kept, one either side removed
 * is dropped, theirs land after their nearest kept predecessor), a record key by key, and a budget
 * by arithmetic. A budget both sides changed differently takes both changes, `ours + theirs - base`,
 * since each side removed or re-counted its own findings in the merged file; the gate's
 * `--check` still holds every merged budget to its exact count. Anything else both sides changed
 * differently is a conflict, and the driver falls back to git's line merge.
 */
import { Array as Arr, Option, Result, Schema } from "effect"
import type { DebtConfig, Policy } from "./effect-debt.ts"

/** A merged value, or the path of the first value both sides changed differently. */
export type Merged<A> = Result.Result<A, string>

/** Merges one key's value: each side's is absent when that side has no such key. */
type Each<A> = (at: string, base: Option.Option<A>, ours: Option.Option<A>, theirs: Option.Option<A>) => Merged<Option.Option<A>>

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const printed = <A>(value: Option.Option<A>) => json(Option.toArray(value))

/** The side that changed, or both when they changed alike; a conflict when they changed differently. */
export const choose = <A>(at: string, base: Option.Option<A>, ours: Option.Option<A>, theirs: Option.Option<A>): Merged<Option.Option<A>> => {
  const [was, mine, other] = Arr.map([base, ours, theirs], printed)
  if (mine === other || was === other) return Result.succeed(ours)
  if (was === mine) return Result.succeed(theirs)
  return Result.fail(at)
}

const chooseValue = <A>(at: string, base: A, ours: A, theirs: A): Merged<A> =>
  Result.map(choose(at, Option.some(base), Option.some(ours), Option.some(theirs)), (merged) => Option.getOrElse(merged, () => ours))

/** A budget: the side that changed, or both changes summed when both did; zero or less drops it. */
export const budget: Each<number> = (at, base, ours, theirs) => {
  const chosen = choose(at, base, ours, theirs)
  if (Result.isSuccess(chosen)) return chosen
  const zero = () => 0
  const sum = Option.getOrElse(ours, zero) + Option.getOrElse(theirs, zero) - Option.getOrElse(base, zero)
  if (sum > 0) return Result.succeed(Option.some(sum))
  return Result.succeed(Option.none())
}

/** Ours' keys in their order, then each of theirs' new keys right after its nearest preceding key of theirs. */
const ordered = (ours: ReadonlyArray<string>, theirs: ReadonlyArray<string>) =>
  Arr.reduce(theirs, Array.from(ours), (keys, key, index) => {
    if (keys.includes(key)) return keys
    const before = Arr.findLast(theirs.slice(0, index), (each) => keys.includes(each))
    const at = Option.match(before, { onNone: () => 0, onSome: (each) => keys.indexOf(each) + 1 })
    return [...keys.slice(0, at), key, ...keys.slice(at)]
  })

type Entries<A> = ReadonlyArray<readonly [string, A]>

const entriesMerge = <A>(at: string, base: Entries<A>, ours: Entries<A>, theirs: Entries<A>, each: Each<A>): Merged<Entries<A>> =>
  Result.gen(function* () {
    const sides = Arr.map([base, ours, theirs], (entries) => new Map(entries))
    const duplicated = Arr.findFirst(Arr.zip([base, ours, theirs], sides), ([entries, map]) => entries.length !== map.size)
    if (Option.isSome(duplicated)) return yield* Result.fail(`${at} (a key twice)`)
    const lookup = (side: number, key: string) => Option.flatMap(Arr.get(sides, side), (map) => Option.fromUndefinedOr(map.get(key)))
    const keys = ordered(Arr.map(ours, ([key]) => key), [...Arr.map(theirs, ([key]) => key), ...Arr.map(base, ([key]) => key)])
    const merged: Array<readonly [string, A]> = []
    for (const key of keys) {
      const value = yield* each(`${at}/${key}`, lookup(0, key), lookup(1, key), lookup(2, key))
      if (Option.isSome(value)) merged.push([key, value.value])
    }
    return merged
  })

/** A record merged key by key. */
export const record =
  <A>(each: Each<A>) =>
  (at: string, base: Readonly<Record<string, A>>, ours: Readonly<Record<string, A>>, theirs: Readonly<Record<string, A>>): Merged<Record<string, A>> =>
    Result.map(entriesMerge(at, Object.entries(base), Object.entries(ours), Object.entries(theirs), each), (entries) => Object.fromEntries(entries))

/** A list merged as a set keyed by `keyOf`; a list with a key twice is a conflict. */
export const keyed =
  <A>(keyOf: (item: A) => string, each: Each<A>) =>
  (at: string, base: ReadonlyArray<A>, ours: ReadonlyArray<A>, theirs: ReadonlyArray<A>): Merged<Array<A>> => {
    const entries = (items: ReadonlyArray<A>) => Arr.map(items, (item) => [keyOf(item), item] as const)
    return Result.map(entriesMerge(at, entries(base), entries(ours), entries(theirs), each), (merged) => Arr.map(merged, ([, item]) => item))
  }

const names = keyed((name: string) => name, choose)

/** An absent record merges as an empty one, and an empty result is absent. */
const nested =
  <A>(merge: (at: string, base: Readonly<Record<string, A>>, ours: Readonly<Record<string, A>>, theirs: Readonly<Record<string, A>>) => Merged<Record<string, A>>): Each<Readonly<Record<string, A>>> =>
  (at, base, ours, theirs) => {
    const empty = () => ({})
    return Result.map(merge(at, Option.getOrElse(base, empty), Option.getOrElse(ours, empty), Option.getOrElse(theirs, empty)), (merged) =>
      Option.liftPredicate(merged, (each) => Object.keys(each).length > 0),
    )
  }

const budgets = record(nested(record(budget)))

const exemptions = keyed((exemption: Policy["exemptions"][number]) => `${exemption.file} ${exemption.rule}`, choose)

/** `effect-debt.json` merged by key: exemptions per (file, rule), budgets per (file, rule). */
export const mergePolicy = (base: Policy, ours: Policy, theirs: Policy): Merged<Policy> =>
  Result.gen(function* () {
    return {
      plugin: yield* chooseValue("plugin", base.plugin, ours.plugin, theirs.plugin),
      oxlint: yield* chooseValue("oxlint", base.oxlint, ours.oxlint, theirs.oxlint),
      provenance: yield* chooseValue("provenance", base.provenance, ours.provenance, theirs.provenance),
      rules: yield* names("rules", base.rules, ours.rules, theirs.rules),
      ignorePatterns: yield* names("ignorePatterns", base.ignorePatterns, ours.ignorePatterns, theirs.ignorePatterns),
      testFiles: yield* names("testFiles", base.testFiles, ours.testFiles, theirs.testFiles),
      exemptions: yield* exemptions("exemptions", base.exemptions, ours.exemptions, theirs.exemptions),
      budgets: yield* budgets("budgets", base.budgets, ours.budgets, theirs.budgets),
    }
  })

type Override = NonNullable<DebtConfig["overrides"]>[number]

const offRules = record(choose<Override["rules"][string]>)

/** One override, keyed by its first file: both sides' files and switched-off rules each merged as sets. */
const override: Each<Override> = (at, base, ours, theirs) => {
  const chosen = choose(at, base, ours, theirs)
  if (Result.isSuccess(chosen) || Option.isNone(ours) || Option.isNone(theirs)) return chosen
  const was = Option.getOrElse(base, () => ({ files: [], rules: {} }))
  return Result.gen(function* () {
    const files = yield* names(`${at}/files`, was.files, ours.value.files, theirs.value.files)
    const rules = yield* offRules(`${at}/rules`, was.rules, ours.value.rules, theirs.value.rules)
    return Option.some({ files, rules })
  })
}

const overrides = keyed((each: Override) => Option.getOrElse(Arr.head(each.files), () => ""), override)

const ruleSettings = record(choose<DebtConfig["rules"][string]>)

/** `.oxlintrc.effect-debt.json` merged by key: rule settings per rule, overrides per first file. */
export const mergeConfig = (base: DebtConfig, ours: DebtConfig, theirs: DebtConfig): Merged<DebtConfig> =>
  Result.gen(function* () {
    const schema = yield* choose("$schema", Option.fromUndefinedOr(base.$schema), Option.fromUndefinedOr(ours.$schema), Option.fromUndefinedOr(theirs.$schema))
    const testFiles = yield* names("settings/effect/testFiles", base.settings.effect.testFiles, ours.settings.effect.testFiles, theirs.settings.effect.testFiles)
    const merged: DebtConfig = {
      ...Option.match(schema, { onNone: () => ({}), onSome: ($schema) => ({ $schema }) }),
      plugins: yield* chooseValue("plugins", base.plugins, ours.plugins, theirs.plugins),
      categories: yield* chooseValue("categories", base.categories, ours.categories, theirs.categories),
      ignorePatterns: yield* names("ignorePatterns", base.ignorePatterns, ours.ignorePatterns, theirs.ignorePatterns),
      jsPlugins: yield* chooseValue("jsPlugins", base.jsPlugins, ours.jsPlugins, theirs.jsPlugins),
      settings: { effect: { testFiles } },
      rules: yield* ruleSettings("rules", base.rules, ours.rules, theirs.rules),
      overrides: yield* overrides("overrides", base.overrides ?? [], ours.overrides ?? [], theirs.overrides ?? []),
    }
    return merged
  })
