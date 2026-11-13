// The machine's accept lock with a yielding deep run (unit accept-deep-owed).
//
// Roles: one deep run ("deep") that works through owed files, and land runs
// ("l1", "l2": a land's `accept:land`, or one run by hand in another checkout).
// One lock, released by the kernel when its holder dies (an flock; no stale
// lock to break). A land run that finds the deep run holding the lock sets a
// wanted mark carrying its own name; a mark whose setter is dead counts as
// unset. The deep run starts no file while a live mark is set, stops the file
// it runs (the file stays owed), releases the lock, and takes it again only
// when no live mark is set. A land run clears its mark when it takes the lock,
// or when it dies.
//
// Checked (quint run, see the spec): the invariants below.
module acceptLock {
  type Phase = Idle | Waiting | Holding | Done | Dead

  val LANDS = Set("l1", "l2")
  val RUNS = LANDS.union(Set("deep"))
  val FILES = Set("a", "b", "c")

  /// Who holds the lock ("" for no one).
  var holder: str
  /// Each run's phase.
  var phase: str -> Phase
  /// The land runs whose wanted mark is set.
  var wanted: Set[str]
  /// The file the deep run is running ("" for none).
  var running: str
  /// The files with a pass in the ledger.
  var passed: Set[str]
  /// Files whose `bun test` was stopped at least once before it ended, in this deep run's current attempt.
  var stopped: Set[str]
  /// Files that ended green in an attempt that was not stopped.
  var finished: Set[str]
  /// Steps the deep run took while holding the lock with a live mark set (must stay under the bound).
  var heldWhileWanted: int

  pure val YIELD_BOUND = 2

  def alive(who: str): bool = phase.get(who) != Dead
  val liveWanted = wanted.filter(who => alive(who))

  action init = all {
    holder' = "",
    phase' = RUNS.mapBy(_ => Idle),
    wanted' = Set(),
    running' = "",
    passed' = Set(),
    stopped' = Set(),
    finished' = Set(),
    heldWhileWanted' = 0,
  }

  /// A run starts and waits for the lock.
  action start(who: str): bool = all {
    phase.get(who) == Idle,
    phase' = phase.set(who, Waiting),
    holder' = holder, wanted' = wanted, running' = running, passed' = passed, stopped' = stopped, finished' = finished,
    heldWhileWanted' = heldWhileWanted,
  }

  /// A waiting land run that sees the deep run holding the lock sets its mark.
  action mark(who: str): bool = all {
    LANDS.contains(who), phase.get(who) == Waiting, holder == "deep", not(wanted.contains(who)),
    wanted' = wanted.union(Set(who)),
    holder' = holder, phase' = phase, running' = running, passed' = passed, stopped' = stopped, finished' = finished,
    heldWhileWanted' = heldWhileWanted,
  }

  /// A waiting land run takes the free lock and clears its mark.
  action landTakes(who: str): bool = all {
    LANDS.contains(who), phase.get(who) == Waiting, holder == "",
    holder' = who,
    phase' = phase.set(who, Holding),
    wanted' = wanted.exclude(Set(who)),
    running' = running, passed' = passed, stopped' = stopped, finished' = finished, heldWhileWanted' = heldWhileWanted,
  }

  /// A land run ends and releases the lock.
  action landEnds(who: str): bool = all {
    LANDS.contains(who), phase.get(who) == Holding, holder == who,
    holder' = "",
    phase' = phase.set(who, Done),
    wanted' = wanted, running' = running, passed' = passed, stopped' = stopped, finished' = finished, heldWhileWanted' = heldWhileWanted,
  }

  /// The deep run takes the free lock, only while no live mark is set.
  action deepTakes = all {
    phase.get("deep") == Waiting, holder == "", liveWanted == Set(),
    holder' = "deep",
    phase' = phase.set("deep", Holding),
    wanted' = wanted, running' = running, passed' = passed, stopped' = stopped, finished' = finished, heldWhileWanted' = 0,
  }

  /// The deep run starts an owed file, only while it holds the lock and no live mark is set.
  action deepStartsFile = all {
    phase.get("deep") == Holding, holder == "deep", running == "", liveWanted == Set(),
    nondet file = FILES.exclude(passed).oneOf()
    all { running' = file, stopped' = stopped.exclude(Set(file)) },
    holder' = holder, phase' = phase, wanted' = wanted, passed' = passed, finished' = finished, heldWhileWanted' = heldWhileWanted,
  }

  /// The running file ends green: it gets its pass, written under the lock.
  action deepFileEnds = all {
    phase.get("deep") == Holding, holder == "deep", running != "",
    passed' = passed.union(Set(running)),
    finished' = finished.union(Set(running)),
    running' = "",
    holder' = holder, phase' = phase, wanted' = wanted, stopped' = stopped,
    heldWhileWanted' = if (liveWanted == Set()) heldWhileWanted else heldWhileWanted + 1,
  }

  /// With a live mark set, the deep run stops its file (it stays owed).
  action deepStops = all {
    phase.get("deep") == Holding, holder == "deep", running != "", liveWanted != Set(),
    stopped' = stopped.union(Set(running)),
    running' = "",
    holder' = holder, phase' = phase, wanted' = wanted, passed' = passed, finished' = finished,
    heldWhileWanted' = heldWhileWanted + 1,
  }

  /// With a live mark set and no file running, the deep run releases the lock and waits again.
  action deepYields = all {
    phase.get("deep") == Holding, holder == "deep", running == "", liveWanted != Set(),
    holder' = "",
    phase' = phase.set("deep", Waiting),
    wanted' = wanted, running' = running, passed' = passed, stopped' = stopped, finished' = finished, heldWhileWanted' = 0,
  }

  /// The deep run has nothing left and ends.
  action deepEnds = all {
    phase.get("deep") == Holding, holder == "deep", running == "", FILES.exclude(passed) == Set(),
    holder' = "",
    phase' = phase.set("deep", Done),
    wanted' = wanted, running' = running, passed' = passed, stopped' = stopped, finished' = finished, heldWhileWanted' = 0,
  }

  /// Any live run dies at any moment: the kernel frees its lock, its file is cut, its mark is dead.
  action dies(who: str): bool = all {
    phase.get(who) != Dead, phase.get(who) != Done,
    phase' = phase.set(who, Dead),
    holder' = if (holder == who) "" else holder,
    running' = if (who == "deep") "" else running,
    stopped' = if (who == "deep" and running != "") stopped.union(Set(running)) else stopped,
    wanted' = wanted, passed' = passed, finished' = finished,
    heldWhileWanted' = if (who == "deep") 0 else heldWhileWanted,
  }

  action step = any {
    nondet who = RUNS.oneOf()
    any { start(who), mark(who), landTakes(who), landEnds(who), dies(who) },
    deepTakes, deepStartsFile, deepFileEnds, deepStops, deepYields, deepEnds,
  }

  // The holder is in its holding phase, and no one else is.
  val oneHolder = RUNS.forall(who => (phase.get(who) == Holding) == (holder == who))
  // A file runs only under the deep run's lock.
  val runsUnderLock = (running == "") or (holder == "deep")
  // A pass is only ever for a file whose run ended green.
  val passesAreFinished = passed.subseteq(finished)
  // The file running now has no stop recorded for this attempt.
  val runningNotStopped = (running == "") or not(stopped.contains(running))
  // Once a live mark is set, the deep run gives the lock up within YIELD_BOUND of its own steps.
  val yieldsSoon = heldWhileWanted <= YIELD_BOUND

  val safe = oneHolder and runsUnderLock and passesAreFinished and runningNotStopped and yieldsSoon
}
