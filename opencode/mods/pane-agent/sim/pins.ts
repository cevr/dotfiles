/**
 * Generated from a run of sim/sim.test.ts at 44f5ed09 (its SIM-SIG lines): for each acceptance check, each red
 * job's exact set of violation signatures (SPEC v2 ruling 7, widened). See sim/known-red.ts.
 */

/** The pin table's contract: check key, then job name, then that job's violation signatures. */
export interface PinTable {
  readonly [check: string]: Readonly<Record<string, ReadonlyArray<string>>>
}

export const PINS: PinTable = {
  "batch await:reattach 1/4": {
    "await:reattach@20": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:reattach@4": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:follow_up 1/4": {
    "await:second:follow_up@104": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@108": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@112": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@116": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@120": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@124": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@128": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@132": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@136": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@140": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@144": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@148": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@152": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@156": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@160": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@164": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@168": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@172": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@32": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@36": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@44": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@48": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@56": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@60": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@68": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@72": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@80": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@84": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@92": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@96": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:follow_up 2/4": {
    "await:second:follow_up@101": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@105": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@109": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@113": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@117": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@121": [
      "I2 w1: <tok> was refused to the caller, yet typed Nx",
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@125": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@129": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@133": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@137": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@141": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@145": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@149": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@153": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@157": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@161": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@165": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@169": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@173": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@37": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@49": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@61": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@73": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@85": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@97": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:follow_up 3/4": {
    "await:second:follow_up@102": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@106": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@110": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@114": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@118": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@122": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@126": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@130": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@134": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@138": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@142": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@146": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@150": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@154": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@158": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@162": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@166": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@170": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@174": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@30": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@38": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@42": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@50": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@54": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@62": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@66": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@74": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@78": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@86": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@90": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:follow_up 4/4": {
    "await:second:follow_up@103": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@107": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@111": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@115": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@119": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@123": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@127": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@131": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@135": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@139": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@143": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@147": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@151": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@155": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@159": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@163": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@167": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@171": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@175": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@31": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@43": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@55": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@67": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@79": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:follow_up@91": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:reattach 1/4": {
    "await:second:reattach@120": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@124": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
    "await:second:reattach@128": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@132": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@136": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@140": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@144": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@148": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@152": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@156": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@20": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@24": [
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@28": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@32": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@36": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@4": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@40": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@44": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@48": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@52": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@56": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@60": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@64": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@68": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@72": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@76": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@8": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@80": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@84": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@88": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:reattach 2/4": {
    "await:second:reattach@121": [
      "I2 w1: <tok> was refused to the caller, yet typed Nx",
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@125": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
    "await:second:reattach@129": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@133": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@137": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@141": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@145": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@149": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@153": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@157": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@21": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@25": [
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@29": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@33": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@37": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@41": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@45": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@49": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@5": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@53": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@57": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@61": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@65": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@69": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@73": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@77": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@81": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@85": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@89": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@9": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@93": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:reattach 3/4": {
    "await:second:reattach@10": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@122": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
    "await:second:reattach@126": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@130": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@134": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@138": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@142": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@146": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@150": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@154": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@158": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@26": [
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@30": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@34": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@38": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@42": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@46": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@50": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@54": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@58": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@62": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@66": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@70": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@74": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@78": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@82": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@86": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:reattach 4/4": {
    "await:second:reattach@119": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@123": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
    "await:second:reattach@127": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@131": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@135": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@139": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@143": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@147": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@151": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@155": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@159": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@23": [
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@27": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@31": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@35": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@39": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@43": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@47": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@51": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@55": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@59": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@63": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@67": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@7": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "await:second:reattach@71": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@75": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@79": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@83": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:reattach@87": [
      "I8 w2: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:steer 1/4": {
    "await:second:steer@104": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@108": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@112": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@116": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@120": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@124": [
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@128": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@132": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@136": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@140": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@144": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@148": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@152": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@156": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@160": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@164": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@168": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@172": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@32": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@36": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@44": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@48": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@56": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@60": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@68": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@72": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@80": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@84": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@92": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@96": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:steer 2/4": {
    "await:second:steer@101": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@105": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@109": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@113": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@117": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@121": [
      "I2 w1: <tok> was refused to the caller, yet typed Nx",
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@125": [
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@129": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@133": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@137": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@141": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@145": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@149": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@153": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@157": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@161": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@165": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@169": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@173": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@37": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@49": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@61": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@73": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@85": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@97": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:steer 3/4": {
    "await:second:steer@102": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@106": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@110": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@114": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@118": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@122": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@126": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@130": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@134": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@138": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@142": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@146": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@150": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@154": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@158": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@162": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@166": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@170": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@174": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@30": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@38": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@42": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@50": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@54": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@62": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@66": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@74": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@78": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@86": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@90": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:steer 4/4": {
    "await:second:steer@103": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@107": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@111": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@115": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@119": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@123": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@127": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@131": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@135": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@139": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@143": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@147": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@151": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@155": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@159": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@163": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@167": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@171": [
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@175": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@31": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@43": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@55": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@67": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@79": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "await:second:steer@91": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop 1/4": {
    "await:second:stop@112": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@116": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@120": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@124": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
    ],
    "await:second:stop@176": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop 2/4": {
    "await:second:stop@109": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@113": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@117": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@121": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@125": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
    ],
    "await:second:stop@173": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@177": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop 3/4": {
    "await:second:stop@106": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@110": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@114": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@118": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@122": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
    ],
    "await:second:stop@126": [
      "I6 w1: at quiescence status says working/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@174": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop 4/4": {
    "await:second:stop@107": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@111": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@115": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@119": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
    ],
    "await:second:stop@123": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
    ],
    "await:second:stop@175": [
      "I6 w1: at quiescence status says done/turn N but the store says stopped/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop_close 1/4": {
    "await:second:stop_close@120": [
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
    ],
    "await:second:stop_close@124": [
      "I2 w1: <tok> was refused to the caller, yet typed Nx",
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
    ],
    "await:second:stop_close@176": [
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
    ],
  },
  "batch await:second:stop_close 2/4": {
    "await:second:stop_close@125": [
      "I2 w1: <tok> was refused to the caller, yet typed Nx",
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
    ],
    "await:second:stop_close@177": [
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
    ],
  },
  "batch await:second:stop_close 3/4": {
    "await:second:stop_close@122": [
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
    ],
    "await:second:stop_close@174": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch await:second:stop_close 4/4": {
    "await:second:stop_close@119": [
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
    ],
    "await:second:stop_close@123": [
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
    ],
    "await:second:stop_close@175": [
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "batch crash 1/4": {
    "crash@64": [
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
  },
  "batch crash 2/4": {
    "crash@125": [
      "I2 w1: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "crash@65": [
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
  },
  "batch crash 3/4": {
    "crash@66": [
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
  },
  "batch crash 4/4": {
    "crash@3": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "crash@67": [
      "I6 w1: done wake for turn N at t=N carries the answer of turn N (<tok>), a turn already reported",
    ],
  },
  "batch pairs 1/6": {
    "pair:notifier.changed:defect#0": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at notifier.changed #N",
    ],
    "pair:pane.close:defect#0": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
    ],
    "pair:pane.read:defect#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.readTail:hang#0": [
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
    ],
    "pair:pane.split:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.waitForQuiet:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.write:defect#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:store.read:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:timer.sleep:hang#0": [
      "I1 status#N (w2) did not answer within N ms",
      "I1 status#N (w2) did not answer within N ms",
    ],
  },
  "batch pairs 2/6": {
    "pair:notifier.changed:defect#1": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.readTail:hang#1": [
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
    ],
    "pair:pane.split:hang#1": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "pair:pane.write:defect#1": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:store.read:hang#1": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "pair:store.write:conflict#1": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "pair:store.write:hang#1": [
      "I1 start#N (w1) did not answer within N ms",
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
  },
  "batch pairs 3/6": {
    "pair:notifier.changed:defect#2": [
      "I1 start#N (w2) died with an untyped defect: Error: sim: defect injected at notifier.changed #N",
    ],
    "pair:pane.readTail:hang#2": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
    ],
    "pair:pane.write:defect#2": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "pair:store.read:hang#2": [
      "I1 reattach#N (*) did not answer within N ms",
    ],
    "pair:store.write:hang#2": [
      "I1 start#N (w1) did not answer within N ms",
    ],
  },
  "batch pairs 4/6": {
    "pair:notifier.changed:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.alive:unsupported#0": [
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
    ],
    "pair:pane.close:hang#0": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
    ],
    "pair:pane.read:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.readTail:defect#0": [
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
    ],
    "pair:pane.split:defect#0": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at pane.split #N",
    ],
    "pair:pane.waitForQuiet:defect#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.write:hang#0": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:results.read:timeout#0": [
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
    ],
    "pair:store.read:defect#0": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at store.read #N",
    ],
    "pair:timer.sleep:defect#0": [
      "I1 status#N (w2) did not answer within N ms",
      "I1 status#N (w2) did not answer within N ms",
    ],
  },
  "batch pairs 5/6": {
    "pair:notifier.changed:hang#1": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:pane.alive:unsupported#1": [
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
    ],
    "pair:pane.read:unsupported#1": [
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
    ],
    "pair:pane.readTail:defect#1": [
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
    ],
    "pair:pane.split:defect#1": [
      "I1 start#N (w2) died with an untyped defect: Error: sim: defect injected at pane.split #N",
    ],
    "pair:pane.write:hang#1": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "pair:store.read:defect#1": [
      "I1 start#N (w2) died with an untyped defect: Error: sim: defect injected at store.read #N",
    ],
    "pair:store.write:crash#1": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "pair:store.write:defect#1": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at store.write #N",
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "pair:store.write:timeout#1": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "pair:store.write:transient#1": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
  },
  "batch pairs 6/6": {
    "pair:notifier.changed:hang#2": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "pair:pane.read:unsupported#2": [
      "I6 w1: status#N says done at t=N, but turn N (<tok>) has not ended in the pane",
    ],
    "pair:pane.readTail:defect#2": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
    ],
    "pair:pane.write:hang#2": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "pair:store.read:defect#2": [
      "I1 reattach#N (*) died with an untyped defect: Error: sim: defect injected at store.read #N",
    ],
    "pair:store.write:defect#2": [
      "I1 start#N (w1) did not answer within N ms",
    ],
  },
  "batch seeds 1/3": {
    "seed:1": [
      "I1 start#N (named1) did not answer within N ms",
      "I1 start#N (w1) did not answer within N ms",
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I6 w2: at quiescence status says needs_input/turn N but the store says needs_input/turn N",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "seed:10": [
      "I1 start#N (w2) did not answer within N ms",
    ],
    "seed:13": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
      "I3 named1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I4 named1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 named1: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 named1: N queued turn(s) never typed though the pane is idle",
    ],
    "seed:28": [
      "I1 restart#N (w1) did not answer within N ms",
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 steer#N (w1) did not answer within N ms",
      "I1 stop#N (w1) did not answer within N ms",
      "I1 stop#N (w1) did not answer within N ms",
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I5 ?: wrote \"\\e\" into <block> while it showed a trust prompt (t=N)",
    ],
    "seed:31": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at store.write #N",
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
    ],
    "seed:34": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
    ],
    "seed:37": [
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 w2 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I4 w2: N distinct wakes for (turn, kind) N:needs_input",
    ],
    "seed:43": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "seed:46": [
      "I1 reattach#N (*) did not answer within N ms",
      "I3 named1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I4 named1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 named1: at quiescence status says stopped/turn N but the store says working/turn N",
      "I6 named1: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 named1: N queued turn(s) never typed though the pane is idle",
    ],
    "seed:49": [
      "I1 reattach#N (*) did not answer within N ms",
    ],
    "seed:52": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at store.read #N",
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 w2 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I4 w2: N distinct wakes for (turn, kind) N:needs_input",
    ],
    "seed:55": [
      "I1 start#N (named1) did not answer within N ms",
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I6 w2: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:58": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
  },
  "batch seeds 2/3": {
    "seed:11": [
      "I1 status#N (named1) did not answer within N ms",
      "I3 named1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 named1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 named1 turn N (<tok>, steer) was accepted but never typed and never reported \"not typed\"",
      "I6 named1: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 named1: N queued turn(s) never typed though the pane is idle",
      "I8 named1: N wake(s) still pending in the outbox at quiescence",
    ],
    "seed:17": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I5 w2: wrote \"\\e\" into <block> while it showed a permission prompt (t=N)",
      "I6 w1: at quiescence status says working/turn N but the store says done/turn N",
      "I6 w2: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 w1: N wake(s) still pending in the outbox at quiescence",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
    "seed:2": [
      "I5 ?: wrote \"\\e\" into <block> while it showed a trust prompt (t=N)",
    ],
    "seed:20": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I4 w1: N distinct wakes for (turn, kind) N:needs_input",
    ],
    "seed:23": [
      "I1 start#N (w2) did not answer within N ms",
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I5 ?: wrote \"\\e\" into <block> while it showed a trust prompt (t=N)",
    ],
    "seed:29": [
      "I1 start#N (w1) did not answer within N ms",
      "I1 start#N (w2) did not answer within N ms",
    ],
    "seed:32": [
      "I1 follow_up#N (w2) did not answer within N ms",
      "I1 start#N (w1) did not answer within N ms",
      "I1 stop_close#N (w2) did not answer within N ms",
    ],
    "seed:38": [
      "I1 status#N (w1) did not answer within N ms",
      "I1 steer#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 w1: N queued turn(s) never typed though the pane is idle",
    ],
    "seed:41": [
      "I3 w2 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: at quiescence the store says working, but no typed turn is open in the pane",
      "I8 w2: N queued turn(s) never typed though the pane is idle",
    ],
    "seed:44": [
      "I1 reattach#N (*) died with an untyped defect: Error: sim: defect injected at store.read #N",
      "I3 w1 turn N (<tok>, follow_up) was accepted but never typed and never reported \"not typed\"",
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I3 w1 turn N (<tok>, steer) was accepted but never typed and never reported \"not typed\"",
    ],
    "seed:47": [
      "I1 start#N (w1) did not answer within N ms",
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:5": [
      "I5 ?: wrote \"\\e\" into <block> while it showed a trust prompt (t=N)",
    ],
    "seed:50": [
      "I1 follow_up#N (w2) did not answer within N ms",
      "I1 reattach#N (*) did not answer within N ms",
      "I1 status#N (w2) did not answer within N ms",
      "I1 status#N (w2) did not answer within N ms",
      "I4 w2 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w2: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:8": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 restart#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
    ],
  },
  "batch seeds 3/3": {
    "seed:12": [
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "seed:21": [
      "I1 start#N (w2) did not answer within N ms",
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I4 named1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 named1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:24": [
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:3": [
      "I1 start#N (w1) died with an untyped defect: Error: sim: defect injected at store.read #N",
    ],
    "seed:30": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 stop_close#N (w1) did not answer within N ms",
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I8 w1: N wake(s) still pending in the outbox at quiescence",
    ],
    "seed:33": [
      "I1 follow_up#N (w2) did not answer within N ms",
      "I1 start#N (w1) did not answer within N ms",
      "I1 stop_close#N (w2) did not answer within N ms",
      "I2 ?: pane <block> was split by the unit and is running, but no worker record owns it and no \"split result unknown\" was reported (orphan)",
    ],
    "seed:36": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 follow_up#N (w2) did not answer within N ms",
      "I1 reattach#N (*) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w2) did not answer within N ms",
      "I1 stop#N (w1) did not answer within N ms",
      "I1 stop#N (w2) did not answer within N ms",
      "I8 w1: N wake(s) still pending in the outbox at quiescence",
    ],
    "seed:42": [
      "I1 start#N (named1) did not answer within N ms",
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:48": [
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
    ],
    "seed:51": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
    ],
    "seed:57": [
      "I3 w1 turn N (<tok>, start) was accepted but never typed and never reported \"not typed\"",
    ],
    "seed:6": [
      "I1 start#N (w1) did not answer within N ms",
    ],
    "seed:60": [
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
      "I6 w1: at quiescence status says done/turn N but the store says working/turn N",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
    "seed:9": [
      "I1 reattach#N (*) did not answer within N ms",
    ],
  },
  "scenario D12-reattach-serial-one-hang": {
    "D12-reattach-serial-one-hang": [
      "I1 reattach#N (*) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
  },
  "scenario F1-changed-defect": {
    "F1-changed-defect": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I8 w1: N queued turn(s) never typed though the pane is idle",
    ],
  },
  "scenario G-write-fails-during-idle-follow-up": {
    "G-write-fails-during-idle-follow-up": [
      "I2 w1: the store records turn N, but the caller saw only N turn(s) accepted",
      "I6 w1: at quiescence status says done/turn N but the store says working/turn N",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
  },
  "scenario H-alive-never-answers": {
    "H-alive-never-answers": [
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 follow_up#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
      "I1 status#N (w1) did not answer within N ms",
    ],
  },
  "scenario I-read-defect-in-watcher": {
    "I-read-defect-in-watcher": [
      "I4 w1 turn N (<tok>) ended in the pane, but no done wake ever carried its answer",
      "I6 w1: at quiescence the store says working, but no typed turn is open in the pane",
    ],
  },
  "scenario Qa-conflict-reload-second-process": {
    "Qa-conflict-reload-second-process": [
      "I6 w1: at quiescence status says done/turn N but the store says done/turn N",
      "I8 w1: with faults off and the pane idle, a follow_up still fails (StoreConflict): the worker is wedged",
    ],
  },
  "scenario usage-limit": {
    "usage-limit": [
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I9 w1 turn N (<tok>) hit the usage limit at t=N, but no \"limited\" wake reported it",
      "I9 w1 turn N (<tok>) hit the usage limit at t=N; never resumed after its reset at t=N and never reported \"not typed\"",
    ],
  },
  "scenario usage-limit-sibling": {
    "usage-limit-sibling": [
      "I6 w1: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I6 w2: done wake for turn N (<tok>) at t=N, but that turn had not ended in the pane",
      "I9 w1 turn N (<tok>) hit the usage limit at t=N, but no \"limited\" wake reported it",
      "I9 w1 turn N (<tok>) hit the usage limit at t=N; never resumed after its reset at t=N and never reported \"not typed\"",
      "I9 w2 turn N (<tok>) hit the usage limit at t=N, but no \"limited\" wake reported it",
      "I9 w2 turn N (<tok>) hit the usage limit at t=N; never resumed after its reset at t=N and never reported \"not typed\"",
    ],
  },
}
