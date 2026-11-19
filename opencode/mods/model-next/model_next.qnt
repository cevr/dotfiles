// A queued model switch: it applies at the next compaction, or at the session's
// next wake once its prompt cache has expired. The interleavings.
//
// One session. The owner queues or cancels a switch, or switches directly, at any
// moment; the session makes requests, its cache expires while it sits idle, it
// compacts (ok or failed), and the server restarts.
//
// `HOOKED` is the design: the switch is applied inside a hook the host awaits,
// in the same atomic step as the compaction's end (`experimental.compaction.ended`)
// or as the start of the turn that follows an expired cache (`experimental.wake`).
// With `HOOKED == false` the apply is a plugin acting on what it heard: after
// `session.compaction.ended` on the event stream (`late`), or from a timer set
// for the cache's expiry (`decide`, then `land`). A request may come between.
//
//   quint run model_next.qnt --main=hooked  --invariant=safe --max-samples=50000 --max-steps=40
//   quint run model_next.qnt --main=hooked  --invariant=distinct --max-samples=50000 --max-steps=40
//   quint run model_next.qnt --main=evented --invariant=cheap --max-samples=50000 --max-steps=40      (violates)
//   quint run model_next.qnt --main=evented --invariant=prompt --max-samples=50000 --max-steps=40     (violates)
module model_next {
  const HOOKED: bool

  type Pending = None | Some(str)

  val MODELS = Set("A", "B", "C")

  /// The session's model, as its durable record has it.
  var model: str
  /// The queued switch, kept in the session's record: a restart keeps it.
  var pending: Pending
  /// The context is long: a request on a model whose cache does not hold it writes it all.
  var long: bool
  /// The model whose cache holds the current context; "" when none does.
  var cached: str
  /// The cache expired while the session sat idle: the next request writes the context whichever model it goes to.
  var free: bool
  /// A compaction completed and its queued switch has not been applied yet (evented design only).
  var owed: bool
  /// The expiry timer decided to apply this model and its switch has not landed yet (evented design only); "" when none.
  var decided: str
  /// The session's model was set by the mod and no request has gone to it yet.
  var byMod: bool
  /// A request wrote a long context it would not have written without the mod.
  var costly: bool
  /// A request went out after a completed compaction while its switch was still owed.
  var overtaken: bool

  action init = all {
    model' = "A",
    pending' = None,
    long' = false,
    cached' = "",
    free' = false,
    owed' = false,
    decided' = "",
    byMod' = false,
    costly' = false,
    overtaken' = false,
  }

  /// The owner queues a switch to another model than the session's.
  action queue = {
    nondet m = MODELS.exclude(Set(model)).oneOf()
    all {
      pending' = Some(m),
      model' = model, long' = long, cached' = cached, free' = free, owed' = owed, decided' = decided, byMod' = byMod, costly' = costly, overtaken' = overtaken,
    }
  }

  action cancel = all {
    pending != None,
    pending' = None,
    owed' = false,
    model' = model, long' = long, cached' = cached, free' = free, decided' = decided, byMod' = byMod, costly' = costly, overtaken' = overtaken,
  }

  /// Anyone selects a model directly: the queued switch is dropped with it.
  action direct = {
    nondet m = MODELS.exclude(Set(model)).oneOf()
    all {
      model' = m,
      pending' = None,
      owed' = false,
      byMod' = false,
      long' = long, cached' = cached, free' = free, decided' = decided, costly' = costly, overtaken' = overtaken,
    }
  }

  /// The idle session's cache runs out.
  action expire = all {
    cached != "",
    cached' = "",
    free' = true,
    model' = model, pending' = pending, long' = long, owed' = owed, decided' = decided, byMod' = byMod, costly' = costly, overtaken' = overtaken,
  }

  /// The model the turn's request goes to: the queued one when the wake hook finds the cache expired, else the session's.
  def woken = match pending {
    | None => model
    | Some(m) => if (HOOKED and free and long) m else model
  }

  /// A turn starts and its request goes out. The conversation grows long.
  action request = {
    val target = woken
    val writes = long and cached != target
    all {
      costly' = (costly or (writes and not(free) and (byMod or target != model))),
      overtaken' = (overtaken or owed),
      model' = target,
      pending' = if (target != model) None else pending,
      cached' = target,
      long' = true,
      free' = false,
      byMod' = false,
      owed' = owed, decided' = decided,
    }
  }

  /// A compaction completes: the outgoing model wrote the summary, the context is short.
  action compacted = all {
    long,
    long' = false,
    cached' = "",
    free' = false,
    decided' = decided, costly' = costly, overtaken' = overtaken,
    match pending {
      | None => all { model' = model, pending' = pending, owed' = false, byMod' = byMod }
      | Some(m) =>
        if (HOOKED) all { model' = m, pending' = None, owed' = false, byMod' = true }
        else all { model' = model, pending' = pending, owed' = true, byMod' = byMod }
    },
  }

  /// The evented design's apply, some time after the compaction ended.
  action late = all {
    not(HOOKED),
    owed,
    match pending {
      | None => all { model' = model, pending' = pending, byMod' = byMod }
      | Some(m) => all { model' = m, pending' = None, byMod' = true }
    },
    owed' = false,
    long' = long, cached' = cached, free' = free, decided' = decided, costly' = costly, overtaken' = overtaken,
  }

  /// The evented design's expiry timer fires and reads the session: expired, a switch queued.
  action decide = all {
    not(HOOKED),
    free,
    long,
    decided == "",
    pending != None,
    decided' = match pending {
      | None => ""
      | Some(m) => m
    },
    model' = model, pending' = pending, long' = long, cached' = cached, free' = free, owed' = owed, byMod' = byMod, costly' = costly, overtaken' = overtaken,
  }

  /// The switch the timer decided on lands.
  action land = all {
    decided != "",
    decided != model,
    model' = decided,
    pending' = None,
    byMod' = true,
    decided' = "",
    long' = long, cached' = cached, free' = free, owed' = owed, costly' = costly, overtaken' = overtaken,
  }

  /// A compaction fails or is interrupted: nothing changes, the switch stays queued.
  action failed = all {
    long,
    model' = model, pending' = pending, long' = long, cached' = cached, free' = free, owed' = owed, decided' = decided, byMod' = byMod, costly' = costly, overtaken' = overtaken,
  }

  /// The server restarts: what is not in the session's record is lost.
  action restart = all {
    owed' = false,
    decided' = "",
    model' = model, pending' = pending, long' = long, cached' = cached, free' = free, byMod' = byMod, costly' = costly, overtaken' = overtaken,
  }

  action step = any { queue, cancel, direct, expire, request, compacted, late, decide, land, failed, restart }

  /// The mod's switch never makes a request write a long context that request would not have written anyway.
  val cheap = not(costly)
  /// No request goes out between a completed compaction and the switch it owed.
  val prompt = not(overtaken)
  val safe = cheap and prompt
  /// A queued switch is never for the session's own model.
  val distinct = match pending { | None => true | Some(m) => m != model }
}

module hooked {
  import model_next(HOOKED = true).*
}

module evented {
  import model_next(HOOKED = false).*
}
