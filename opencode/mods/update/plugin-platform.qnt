// The installer's pair of fork build and plugin tree, across the plugin-platform floor.
//
// A build is a pair: the fork commit it was built from and the dotfiles tree beside it
// (mods/update/trees.ts). A consumer tree's plugins need the host's FileSystem, Path and
// ChildProcessSpawner, which only a fork with the floor commit F in its history provides
// (mods/update/process/pin.ts PLATFORM_FLOOR). The stage runs the target tree's own daily
// (process/builder.ts treeStageCommand), so the guard that runs is the target tree's: an old
// tree has none (and needs none), the floor tree and every consumer after it have it
// (pin.ts requireFloor, before the build tree moves or anything installs). The handoff
// installs the staged build; a rollback is a record write back to the prior build
// (model.ts rollBackTree), which stages and builds nothing, so no guard runs in it.
//
// quint run --backend=typescript --seed=0x128e38bf69682 --max-steps=12 --step=beforeFloor --invariant=noBadPair plugin-platform.qnt
//   finds the unsafe stage -> handoff: a consumer tree staged on a fork below the floor, with no guard.
// quint verify --max-steps=8 --invariant=validBuildSlots plugin-platform.qnt
//   finds none in the guarded model: every current, prior and staged build is a compatible pair.
// The production test of the same histories over real git is pin.test.ts ("stage, handoff, retry and rollback histories").
module pluginPlatform {
  type Build = { tree: str, fork: str }
  type Host = { current: Build, prior: Build, staged: Build }

  // pre: an ancestor of F; floor: F itself; after: a descendant of F; divergent: a branch that never meets F.
  val forks = Set("pre", "floor", "after", "divergent")
  // old: a tree before the floor unit; floorTree: the floor unit's; consumer: a tree whose plugins use the platform.
  val trees = Set("old", "floorTree", "consumer")
  val hosts = Set("mac", "workbox")
  val oldPair = { tree: "old", fork: "pre" }

  // The simple predicate the guard must match: the fork has F in its history.
  pure def platform(fork: str): bool = fork == "floor" or fork == "after"
  pure def needs(tree: str): bool = tree == "consumer"
  pure def guarded(tree: str): bool = tree != "old"
  pure def compatible(b: Build): bool = not(needs(b.tree)) or platform(b.fork)
  // What a stage admits: with the guard, a tree that carries it builds only a fork at or past the floor.
  pure def admits(b: Build, withGuard: bool): bool = not(withGuard and guarded(b.tree)) or platform(b.fork)

  var machines: str -> Host

  action init = machines' = hosts.mapBy(_ => { current: oldPair, prior: oldPair, staged: oldPair })

  // A refused stage changes nothing: no record, no launcher, no staged build.
  action stage(h: str, b: Build, withGuard: bool): bool = all {
    admits(b, withGuard),
    machines' = machines.set(h, { ...machines.get(h), staged: b }),
  }

  action handoff(h: str): bool = {
    val m = machines.get(h)
    machines' = machines.set(h, { ...m, current: m.staged, prior: m.current })
  }

  // A record write back to the prior build: nothing is staged or built, so no guard runs.
  action rollback(h: str): bool = {
    val m = machines.get(h)
    machines' = machines.set(h, { ...m, current: m.prior })
  }

  action transition(withGuard: bool): bool = {
    nondet h = hosts.oneOf()
    any {
      { nondet t = trees.oneOf()
        nondet f = forks.oneOf()
        stage(h, { tree: t, fork: f }, withGuard) },
      handoff(h),
      rollback(h),
    }
  }

  action step = transition(true)
  // Before the floor unit: the same trees with no guard, the unsafe pairing the guard closes.
  action beforeFloor = transition(false)

  val noBadPair = hosts.forall(h => compatible(machines.get(h).current))
  val validBuildSlots = hosts.forall(h => {
    val m = machines.get(h)
    compatible(m.current) and compatible(m.prior) and compatible(m.staged)
  })
  // An invariant of the guard itself: restaging the old pair is never refused (its tree carries no guard), and the
  // floor tree refuses a fork below the floor, so the floor unit installs only after a fork with F does.
  val oldPairAdmitted = admits(oldPair, true) and not(admits({ tree: "floorTree", fork: "pre" }, true))
}
