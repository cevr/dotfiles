// The orchestrate batch machine (mods/orchestrate/machine.ts `machine`), as a
// Quint model, and the world it runs in: implementors that hand back, a batch
// verifier, and `rift` lands, whose check (`Machines.land`, the tool's
// execute.before hook in cmd/orchestrate/server.ts) and record
// (`Machines.landed`, its execute.after hook) are two steps with the rift tool's
// own claim of its integration Rift (mods/rift/model.ts `claimed`, `busy`)
// between them.
//
// The property, `pipeline` (SKILL.md, "The pipeline"): a batch lands only once
// the batch before it has its verdict, and only with every finding of that
// verdict folded into a unit the land takes, or into one still implementing
// or stopped (it rides with that unit's later land). The ghost record `g`
// tracks what happened in the world, apart from what the machine believes;
// the property reads only `g`.
//
// The model mirrors `decide` and `evolve` one command at a time: each step is
// one `ledger.decide` (one atomic step in the code, under the store's lock).
// formal/orchestrate/replay.ts replays the traces `quint run` writes through
// the real `machine()`, and fails where the code decides or folds otherwise:
// so a pass covers the code, not just this file.
//
// Scope: three units, one finding each, no `departs`, no `direct` unit, no
// time (the replay's cadence is 1 ready, so `BatchNotDue` never fires), one
// repository (one integration Rift), and every land names its Rifts as
// `{ path, unit }`.
module machine {
  // ── The bounded domain ──

  pure val UNITS = Set("a", "b", "c")
  pure val FINDINGS = Set("a/1", "b/1", "c/1")
  /** machine.ts `unitOfFinding`: the unit a finding is of. */
  pure val OWNER = Map("a/1" -> "a", "b/1" -> "b", "c/1" -> "c")
  /** The batch verifiers' names, in order: `verifier batch-<k> r1`. */
  pure val BATCHES = ["batch-1", "batch-2", "batch-3", "batch-4", "batch-5", "batch-6", "batch-7", "batch-8"]
  pure val IMPLEMENTOR_VERDICTS = Set("ready", "blocked", "stuck", "none", "stopped")
  pure val VERIFIER_VERDICTS = Set("accepted", "changes", "stuck", "none", "stopped")

  // ── The machine's state (machine.ts `MachineState`) ──

  /** A unit: its state (`implement`, `ended`, `ready`, `landed`, `verify`) and what an ended one said ("" for none). */
  type Unit = { state: str, said: str }
  /** A finding: its verdict's batch, and the unit it was folded into ("" for none). */
  type Finding = { batch: str, into: str }
  type Machine = {
    units: str -> Unit,
    verifierOn: bool,
    vBatch: str,
    vUnits: Set[str],
    unverified: Set[str],
    findings: str -> Finding,
    carried: str -> Finding,
    unresolved: Set[str],
  }

  /** The command the step fed the machine ("none": a step of the world alone). */
  type Cmd = {
    kind: str,
    unit: str,
    units: Set[str],
    verdict: str,
    findings: Set[str],
    folds: Set[str],
    batch: str,
    unread: bool,
  }

  // ── The world, as it happened (the ghost) ──

  /** A finding the world owes a land: where it was folded ("" for nowhere), and whether its report was read. */
  type Owed = { into: str, known: bool }
  type Ghost = {
    /** Each unit's implementor: `never` (no round started), `implementing`, `ready`, `stopped`, `landed`, `idle` (dropped). */
    status: str -> str,
    /** The units on main with no verdict over them yet. */
    unverdicted: Set[str],
    /** What the running verifier verifies: what was on main, unverdicted, when it started. */
    verifying: Set[str],
    verifierOn: bool,
    owed: str -> Owed,
    /** A `changes` verdict's findings whose report did not read, by batch: what a read finds. */
    unread: str -> Set[str],
    /** Whether every land so far kept the pipeline rule, and the first break. */
    ok: bool,
    broke: str,
  }

  var m: Machine
  var g: Ghost
  var cmd: Cmd
  /** The rule the machine refused `cmd` by, "" when it took it. */
  var refused: str
  /**
   * The lands the machine let through, not claimed by the rift tool yet, each with how it breaks the pipeline
   * rule in the world as it stood when the machine let it through ("" for none): a land breaks the rule when it
   * goes on to merge. (A call is claimed microseconds after its check: no verdict and no land's end comes
   * between them.)
   */
  var calls: Set[{ rifts: Set[str], broke: str }]
  /** The land the rift tool runs (its integration Rift busy), and whether one runs. */
  var landing: Set[str]
  var landingOn: bool
  var batchCount: int

  // ── Helpers ──

  pure def without(mp: str -> Finding, ks: Set[str]): str -> Finding = mp.keys().exclude(ks).mapBy(k => mp.get(k))
  pure def stateOf(s: Machine, u: str): str = if (s.units.keys().contains(u)) s.units.get(u).state else ""
  /** machine.ts `unitsIn`. */
  pure def unitsIn(s: Machine, states: Set[str]): Set[str] = s.units.keys().filter(u => states.contains(s.units.get(u).state))

  pure val NO_CMD: Cmd = { kind: "none", unit: "", units: Set(), verdict: "", findings: Set(), folds: Set(), batch: "", unread: false }

  // ── decide: the rules ──

  /** machine.ts `named`: the units a land's Rifts name that it lands (ready or ended). */
  pure def named(s: Machine, rifts: Set[str]): Set[str] = rifts.intersect(unitsIn(s, Set("ready", "ended")))

  /** machine.ts `holdsNoLand` (`riding` or `endedWith`; `settled` never holds: every ended unit here said why). */
  pure def holdsNoLand(s: Machine, f: Finding): bool = f.into != "" and Set("implement", "ended").contains(stateOf(s, f.into)) // mutant: holds-no-land

  /** machine.ts `unfoldedOf`. */
  pure def unfoldedOf(s: Machine, lands: Set[str]): Set[str] =
    s.findings.keys().filter(k => {
      val f = s.findings.get(k)
      f.into == "" or (not(lands.contains(f.into)) and not(holdsNoLand(s, f)))
    })

  /** machine.ts `verdictPending`. */
  pure def verdictPending(s: Machine): bool =
    s.verifierOn or s.unverified != Set() or unitsIn(s, Set("landed", "verify")) != Set()

  /** machine.ts `decide` for `Land`: the first rule it breaks, "" when it passes. */
  pure def landRule(s: Machine, rifts: Set[str]): str = {
    val lands = named(s, rifts)
    if (lands == Set()) ""
    else if (verdictPending(s)) "VerdictPending" // mutant: verdict-pending
    else if (unfoldedOf(s, lands) != Set() or s.unresolved != Set()) "FindingUnfolded" // mutant: finding-unfolded
    else if (unitsIn(s, Set("ready")).exists(u => not(lands.contains(u)))) "LandPartial"
    else ""
  }

  /** machine.ts `decide` for a verifier's `Start`. */
  pure def verifierRule(s: Machine, isBatch: bool): str =
    if (not(isBatch) and s.units.keys() != Set()) "VerifierPerUnit"
    else if (s.verifierOn) "VerifierRunning"
    else ""

  /** machine.ts `coverOf`: what is landed and unverified, else what is ready. */
  pure def coverOf(s: Machine): Set[str] = {
    val landed = s.unverified.union(unitsIn(s, Set("landed")))
    if (landed != Set()) landed else unitsIn(s, Set("ready"))
  }

  /** machine.ts `foldsOf`: the open findings an implementor's start folds into its unit. */
  pure def foldsOf(s: Machine, u: str, folds: Set[str]): Set[str] =
    s.findings.keys().filter(k => s.findings.get(k).into != u and (OWNER.get(k) == u or folds.contains(k)))

  /** machine.ts `releasedBy`. */
  pure def releasedBy(s: Machine, u: str): Set[str] =
    s.findings.keys().filter(k => {
      val f = s.findings.get(k)
      f.into == u or (f.into == "" and OWNER.get(k) == u)
    })

  // ── evolve ──

  /** `UnitStarted`, then a `FindingFolded` per finding its start folds. */
  pure def started(s: Machine, u: str, folds: Set[str]): Machine = {
    val folded = foldsOf(s, u, folds)
    {
      ...s,
      units: s.units.put(u, { state: "implement", said: "" }),
      unverified: if (stateOf(s, u) == "landed") s.unverified.union(Set(u)) else s.unverified,
      findings: s.findings.keys().mapBy(k => if (folded.contains(k)) { ...s.findings.get(k), into: u } else s.findings.get(k)),
    }
  }

  /** An implementor's `HandBack`: `UnitHandedBack` when it was implementing, or an ended one says `ready`. */
  pure def handedBack(s: Machine, u: str, v: str): Machine = {
    val was = stateOf(s, u)
    if (was == "implement" or (was == "ended" and v == "ready"))
      { ...s, units: s.units.put(u, if (v == "ready") { state: "ready", said: "" } else { state: "ended", said: v }) }
    else s
  }

  /** `VerifierStarted` over `coverOf`, with the findings its start stands in a land by hand for. */
  pure def verifierStarted(s: Machine, batch: str): Machine = {
    val cover = coverOf(s)
    val standsIn = cover.filter(u => stateOf(s, u) == "ready" and not(s.unverified.contains(u)))
    val standIn = s.findings.keys().filter(k => s.findings.get(k).into != "" and standsIn.contains(s.findings.get(k).into))
    {
      ...s,
      units: s.units.keys().mapBy(u => {
        val unit = s.units.get(u)
        if (cover.contains(u) and (unit.state == "landed" or (unit.state == "ready" and not(s.unverified.contains(u))))) { ...unit, state: "verify" }
        else unit
      }),
      carried: standIn.fold(s.carried, (acc, k) => acc.put(k, s.findings.get(k))),
      findings: without(s.findings, standIn),
      unverified: s.unverified.exclude(cover),
      verifierOn: true,
      vBatch: batch,
      vUnits: if (s.verifierOn) s.vUnits.union(cover) else cover,
    }
  }

  /** `VerifierEnded`: a silent one (`none`, `stopped`) leaves its units landed and unverified; a verdict takes them out and opens its findings. */
  pure def verifierEnded(s: Machine, verdict: str, found: Set[str], unread: bool): Machine = {
    val silent = verdict == "none" or verdict == "stopped" // mutant: silent-verdict
    val off = { ...s, verifierOn: false, vBatch: "", vUnits: Set() }
    if (silent) {
      ...off,
      units: s.units.keys().mapBy(u => if (s.units.get(u).state == "verify") { ...s.units.get(u), state: "landed" } else s.units.get(u)),
      unverified: s.unverified.union(s.vUnits),
    }
    else {
      val units = s.units.keys().filter(u => s.units.get(u).state != "verify").mapBy(u => s.units.get(u))
      val kept = s.findings.keys().filter(k => s.findings.get(k).into == "" or units.keys().contains(s.findings.get(k).into))
      val findings = found.fold(kept.mapBy(k => s.findings.get(k)), (acc, k) => acc.put(k, { batch: s.vBatch, into: "" }))
      {
        ...off,
        units: units,
        findings: findings,
        carried: Map(),
        unresolved: if (unread) s.unresolved.union(Set(s.vBatch)) else s.unresolved,
      }
    }
  }

  /** `ReportResolved`: an unresolved verdict's report read at last. */
  pure def reportRead(s: Machine, batch: str, found: Set[str]): Machine =
    if (s.unresolved.contains(batch))
      { ...s, unresolved: s.unresolved.exclude(Set(batch)), findings: found.fold(s.findings, (acc, k) => acc.put(k, { batch: batch, into: "" })) }
    else s

  /** `UnitDropped`. */
  pure def dropped(s: Machine, u: str): Machine = {
    val released = releasedBy(s, u)
    val ends = Set("implement", "ended", "ready").contains(stateOf(s, u))
    if (not(ends) and released == Set()) s
    else {
      ...s,
      units: if (ends) s.units.keys().exclude(Set(u)).mapBy(x => s.units.get(x)) else s.units,
      findings: without(s.findings, released),
    }
  }

  /** `Landed`: `BatchLanded` of the named units, carrying the findings folded into them. */
  pure def landed(s: Machine, rifts: Set[str]): Machine = {
    val lands = named(s, rifts)
    if (lands == Set()) s
    else {
      val carry = s.findings.keys().filter(k => lands.contains(s.findings.get(k).into))
      val gone = s.findings.keys().filter(k => s.findings.get(k).into == "")
      {
        ...s,
        units: s.units.keys().mapBy(u => if (lands.contains(u)) { state: "landed", said: "" } else s.units.get(u)),
        unverified: s.unverified.union(lands),
        findings: without(s.findings, carry.union(gone)),
        carried: carry.fold(s.carried, (acc, k) => acc.put(k, s.findings.get(k))),
        unresolved: Set(),
      }
    }
  }

  // ── The property ──

  /** Why a land of `rifts` starting now breaks the pipeline rule, in the world; "" when it keeps it. */
  pure def breakOf(w: Ghost, rifts: Set[str]): str =
    if (w.unverdicted != Set()) "VerdictMissing"
    else if (w.owed.keys().exists(k => {
      val o = w.owed.get(k)
      o.into == "" or (not(rifts.contains(o.into)) and not(Set("implementing", "stopped").contains(w.status.get(o.into))))
    })) "FindingLeft"
    else ""

  /** A batch lands only once the batch before has its verdict, with every finding of it folded into a unit the land takes or one that rides. */
  val pipeline = g.ok

  // ── Witnesses: the runs reach what the property is about (each must show up in some trace) ──

  val witnessSecondBatch = g.ok and batchCount >= 2 and landingOn
  val witnessFoldedLand = m.carried.keys() != Set()
  val witnessRefusedPending = refused == "VerdictPending"
  val witnessRefusedUnfolded = refused == "FindingUnfolded"

  // ── The steps ──

  action init = all {
    m' = { units: Map(), verifierOn: false, vBatch: "", vUnits: Set(), unverified: Set(), findings: Map(), carried: Map(), unresolved: Set() },
    g' = { status: UNITS.mapBy(_ => "never"), unverdicted: Set(), verifying: Set(), verifierOn: false, owed: Map(), unread: Map(), ok: true, broke: "" },
    cmd' = NO_CMD,
    refused' = "",
    calls' = Set(),
    landing' = Set(),
    landingOn' = false,
    batchCount' = 0,
  }

  /** The machine took `c` into `next` (or refused it by `rule`); the world moved to `w`. */
  action fed(c: Cmd, rule: str, after: Machine, w: Ghost): bool = all {
    m' = if (rule == "") after else m,
    g' = w,
    cmd' = c,
    refused' = rule,
  }

  /**
   * An implementor starts on `u` (a unit's first round or its next), folding `folds` as well as its own unit's
   * findings. Unless `free`, never on a unit whose land runs (from its check to its record): finding F3
   * (`stepRestartLanding`).
   */
  action implementorStarts(free: bool): bool = {
    nondet u = UNITS.oneOf()
    nondet folds = FINDINGS.powerset().oneOf()
    val folded = g.owed.keys().filter(k => g.owed.get(k).known and g.owed.get(k).into != u and (OWNER.get(k) == u or folds.contains(k)))
    all {
      free or not(landingNow(u)),
      fed(
        { ...NO_CMD, kind: "ImplStart", unit: u, folds: folds },
        "",
        started(m, u, folds),
        { ...g, status: g.status.set(u, "implementing"), owed: g.owed.keys().mapBy(k => if (folded.contains(k)) { ...g.owed.get(k), into: u } else g.owed.get(k)) },
      ),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /** A running (or stopped) implementor hands back. */
  action implementorHandsBack = {
    nondet u = UNITS.filter(x => Set("implementing", "stopped").contains(g.status.get(x))).oneOf()
    nondet v = IMPLEMENTOR_VERDICTS.oneOf()
    all {
      Set("implementing", "stopped").contains(g.status.get(u)),
      fed({ ...NO_CMD, kind: "ImplHandBack", unit: u, verdict: v }, "", handedBack(m, u, v), { ...g, status: g.status.set(u, if (v == "ready") "ready" else "stopped") }),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /**
   * The root starts `verifier batch-<k> r1`. Unless `free`, only once a batch landed with no verdict yet: the
   * world has no land by hand, so a verifier over ready units that never landed (machine.ts `standInFindings`,
   * the start standing in for a land by hand) is the root's error: finding F1 (`stepVerifyEarly`).
   */
  action batchVerifierStarts(free: bool): bool = {
    val batch = BATCHES[if (batchCount < BATCHES.length()) batchCount else BATCHES.length() - 1]
    val rule = verifierRule(m, true)
    all {
      batchCount < BATCHES.length(),
      free or g.unverdicted != Set(),
      fed(
        { ...NO_CMD, kind: "VerifierStart", batch: batch },
        rule,
        verifierStarted(m, batch),
        if (rule == "") { ...g, verifierOn: true, verifying: g.unverdicted } else g,
      ),
      calls' = calls, landing' = landing, landingOn' = landingOn,
      batchCount' = if (rule == "") batchCount + 1 else batchCount,
    }
  }

  /** The root starts a verifier named for a unit (`verifier a r1`), which the machine refuses while it has units. */
  action unitVerifierStarts = {
    nondet u = UNITS.oneOf()
    val rule = verifierRule(m, false)
    all {
      fed({ ...NO_CMD, kind: "VerifierStart", batch: u }, rule, m, g),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /**
   * The running verifier hands back. A verdict takes minutes, a land's check and its claim microseconds: no
   * verdict comes between them (`calls` empty).
   */
  action verifierHandsBack = {
    nondet verdict = VERIFIER_VERDICTS.oneOf()
    nondet found = FINDINGS.powerset().oneOf()
    nondet unread = Set(true, false).oneOf()
    val changes = verdict == "changes"
    val reported = if (changes) found else Set()
    val notRead = changes and unread
    val silent = verdict == "none" or verdict == "stopped"
    all {
      m.verifierOn,
      calls == Set(),
      fed(
        { ...NO_CMD, kind: "VerifierHandBack", verdict: verdict, batch: m.vBatch, findings: if (notRead) Set() else reported, unread: notRead },
        "",
        verifierEnded(m, verdict, if (notRead) Set() else reported, notRead),
        if (silent) { ...g, verifierOn: false, verifying: Set() }
        else {
          ...g,
          verifierOn: false,
          verifying: Set(),
          unverdicted: g.unverdicted.exclude(g.verifying),
          owed: reported.fold(g.owed, (acc, k) => acc.put(k, { into: "", known: not(notRead) })),
          unread: if (notRead) g.unread.put(m.vBatch, reported) else g.unread,
        },
      ),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /** The plugin reads an unresolved verdict's report again (before a start or a land), and finds what it held. */
  action reportReads = {
    nondet batch = m.unresolved.oneOf()
    val found = if (g.unread.keys().contains(batch)) g.unread.get(batch) else Set()
    all {
      m.unresolved.contains(batch),
      fed(
        { ...NO_CMD, kind: "ReportRead", batch: batch, findings: found },
        "",
        reportRead(m, batch, found),
        { ...g, owed: g.owed.keys().mapBy(k => if (found.contains(k)) { ...g.owed.get(k), known: true } else g.owed.get(k)) },
      ),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /** Whether `u`'s land runs: from its check (`calls`) to its record. */
  def landingNow(u: str): bool = landing.contains(u) or calls.exists(call => call.rifts.contains(u))

  /**
   * The root drops a unit: it ends, and releases the findings folded into it and its own folded nowhere.
   * Unless `free`, never a unit whose land runs: finding F3 (`stepRestartLanding`).
   */
  action unitDrops(free: bool): bool = {
    nondet u = UNITS.oneOf()
    val released = g.owed.keys().filter(k => g.owed.get(k).known and (g.owed.get(k).into == u or (g.owed.get(k).into == "" and OWNER.get(k) == u)))
    all {
      free or not(landingNow(u)),
      fed(
        { ...NO_CMD, kind: "Drop", unit: u },
        "",
        dropped(m, u),
        {
          ...g,
          status: if (Set("implementing", "ready", "stopped").contains(g.status.get(u))) g.status.set(u, "idle") else g.status,
          owed: g.owed.keys().exclude(released).mapBy(k => g.owed.get(k)),
        },
      ),
      calls' = calls, landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /**
   * The root calls `rift` land on `rifts`: the machine checks it (execute.before); passed, the call goes on to
   * the tool. Unless `free`, the root lands only units whose implementor handed back (`ready`, or stopped: the
   * land is the root's word that it is ready). A free root also lands a Rift no implementor of the run worked
   * in, a unit still implementing, one landed already, or one it dropped: finding F2 (`stepLandAny`).
   */
  action landCalled(free: bool): bool = {
    nondet rifts = UNITS.powerset().exclude(Set(Set())).oneOf()
    val rule = landRule(m, rifts)
    all {
      calls.size() < 2,
      free or rifts.forall(u => Set("ready", "stopped").contains(g.status.get(u))),
      fed({ ...NO_CMD, kind: "Land", units: rifts }, rule, m, g),
      calls' = if (rule == "") calls.union(Set({ rifts: rifts, broke: breakOf(g, rifts) })) else calls,
      landing' = landing, landingOn' = landingOn, batchCount' = batchCount,
    }
  }

  /** The rift tool claims its integration Rift for a call the machine let through, or refuses it while another lands. */
  action landClaimed = {
    nondet call = calls.oneOf()
    all {
      calls.contains(call),
      m' = m, cmd' = NO_CMD, refused' = "",
      calls' = calls.exclude(Set(call)),
      landing' = if (landingOn) landing else call.rifts,
      landingOn' = true,
      g' = if (landingOn or call.broke == "" or not(g.ok)) g else { ...g, ok: false, broke: call.broke },
      batchCount' = batchCount,
    }
  }

  /**
   * The land ends: pushed, the plugin records `Landed` (execute.after); red, nothing is recorded. A land takes
   * a minute or more, a call's check and its claim microseconds: no land ends between them (`calls` empty).
   */
  action landEnds = {
    nondet green = Set(true, false).oneOf()
    all {
      landingOn,
      calls == Set(),
      landingOn' = false,
      landing' = Set(),
      calls' = calls,
      batchCount' = batchCount,
      if (green)
        fed(
          { ...NO_CMD, kind: "Landed", units: landing },
          "",
          landed(m, landing),
          {
            ...g,
            status: g.status.keys().mapBy(u => if (landing.contains(u)) "landed" else g.status.get(u)),
            unverdicted: g.unverdicted.union(landing),
            owed: g.owed.keys().filter(k => not(landing.contains(g.owed.get(k).into))).mapBy(k => g.owed.get(k)),
          },
        )
      else all { m' = m, g' = g, cmd' = NO_CMD, refused' = "" },
    }
  }

  /**
   * Every step, the root keeping three orders the machine does not check (the receipt's run): it starts a batch
   * verifier only once a batch landed, it lands only units that handed back, and it starts no round of a unit
   * while that unit lands. Each order the root breaks is a finding, explored by its own step below.
   */
  action step = steps(false, false, false)

  /** Finding F1: the root may also start a batch verifier before its batch lands. */
  action stepVerifyEarly = steps(true, false, false)

  /** Finding F2: the root may also land any Rift, whatever the ledger holds of its unit. */
  action stepLandAny = steps(false, true, false)

  /** Finding F3: the ledger may also lose a unit while its land runs: its next round starts, or the root drops it. */
  action stepRestartLanding = steps(false, false, true)

  // The simulator picks among the enabled actions evenly: the rarer calls share one pick, so a run of 40 steps
  // reaches a second batch's land with folded findings (the witnesses count how often).
  action steps(verifyEarly: bool, landAny: bool, restartLanding: bool): bool = any {
    implementorStarts(restartLanding),
    implementorHandsBack,
    batchVerifierStarts(verifyEarly),
    verifierHandsBack,
    landCalled(landAny),
    landClaimed,
    landEnds,
    any { reportReads, unitDrops(restartLanding), unitVerifierStarts },
  }
}
