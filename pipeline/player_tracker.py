"""Per-player constant-velocity Kalman trackers in pitch coordinates.

Detections are anonymous per frame; this module owns identity across frames:
nearest-neighbour association in meter space, Kalman smoothing, velocity
coasting through calibration loss (camera transitions), and the reconciliation
policy on recovery — blend small corrections, snap huge ones, never ghost-glide.
Rendering reads tracks, not raw detections, so dots never flicker with
detection noise.
"""
import numpy as np

GATE_M = 2.0           # association gate per frame (~sprint speed + detection jitter)
RELOCK_M = 6.0         # second tier: calibration micro-shifts re-lock with blending
REACQ_GATE_M = 25.0    # wide gate: coasted tracks re-locking after a transition
BLEND_M = 12.0         # re-lock distance below which we blend; above: controlled snap
REACQUIRE_FRAMES = 6   # blend duration when a coasted track re-locks
R_BLOWUP = 8.0         # measurement-noise inflation during re-acquisition
MAX_COAST = 15         # live-mode frames a track survives without measurements
COAST_DAMP = 0.88      # velocity decay per coasting frame (gentle stop, no run-away)
MIN_AGE = 2            # frames before a new track is rendered (kills spawn flicker)
MERGE_M = 0.7          # tracks closer than this collapse into the stronger one
SPAWN_GATE_M = 8.0     # no new track if some track already sits this close
MAX_TRACKS = 30

X_MIN, X_MAX, Y_MIN, Y_MAX = -3.0, 108.0, -3.0, 71.0  # display box (matches frontend inField)

F = np.array([[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], float)
H_MAT = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], float)
Q = np.diag([0.03, 0.03, 0.20, 0.20])   # player-grade acceleration noise
R = np.diag([0.15, 0.15])               # detection jitter ~0.39 m std
P0 = np.diag([0.5, 0.5, 4.0, 4.0])


class _Track:
    __slots__ = (
        "tid", "state", "cov", "team", "conf", "img", "coast", "reacq", "age", "seen",
        "matches",
    )

    def __init__(self, tid, x, y, team, conf, img):
        self.tid = tid
        self.state = np.array([x, y, 0.0, 0.0])
        self.cov = P0.copy()
        self.team = team
        self.conf = conf
        self.img = img
        self.coast = 0
        self.reacq = 0
        self.age = 1
        self.seen = 1
        self.matches = 1  # matched (not coasted) frames — identity confidence basis


class PlayerTracker:
    """One instance per sequence; all calls must be serialized by the caller."""

    def __init__(self):
        self.tracks = []
        self._next_tid = 1

    def reset(self):
        self.tracks = []
        self._next_tid = 1

    def update(self, meas, frozen=False, wide_gate=False):
        """meas: list of {x, y, team, conf, img} in pitch meters (may be empty).

        frozen=True  -> calibration untrusted: every track coasts (velocity
                        decays to a gentle stop); tracks are never pruned.
        wide_gate=True -> the current homography is stale-but-close (carried):
                        association runs at the wide gate and distant matches
                        blend, so global H drift becomes a smooth glide.
        Returns render list: {x, y, team, conf, img, coasting}."""
        for t in self.tracks:
            t.state = F @ t.state
            t.cov = F @ t.cov @ F.T + Q

        preds = [t.state[:2] for t in self.tracks]
        matches = []  # (track_idx, meas_idx, distance)
        used_t = set()
        used_m = set()
        assoc_gate = REACQ_GATE_M if wide_gate else GATE_M
        if not frozen and meas:
            pairs = []
            for ti, p in enumerate(preds):
                for mi, m in enumerate(meas):
                    d = float(np.hypot(m["x"] - p[0], m["y"] - p[1]))
                    if d <= assoc_gate:
                        pairs.append((d, ti, mi))
            pairs.sort(key=lambda e: e[0])
            for d, ti, mi in pairs:
                if ti in used_t or mi in used_m:
                    continue
                used_t.add(ti)
                used_m.add(mi)
                matches.append((ti, mi, d))
                if d > GATE_M:
                    self.tracks[ti].reacq = REACQUIRE_FRAMES
            # second tier: measurements a few meters off every track are usually
            # a small calibration shift, not new players — re-lock and BLEND so
            # H drift becomes a smooth glide instead of a mass respawn
            for ti, p in enumerate(preds):
                if ti in used_t:
                    continue
                best = None
                for mi, m in enumerate(meas):
                    if mi in used_m:
                        continue
                    d = float(np.hypot(m["x"] - p[0], m["y"] - p[1]))
                    if d <= RELOCK_M and (best is None or d < best[0]):
                        best = (d, mi)
                if best is not None:
                    used_t.add(ti)
                    used_m.add(best[1])
                    matches.append((ti, best[1], best[0]))
                    self.tracks[ti].reacq = REACQUIRE_FRAMES
            # recovery pass: tracks that coasted through a transition re-lock
            # here; far matches snap (identity kept) instead of ghost-gliding
            if not wide_gate:
                for ti, t in enumerate(self.tracks):
                    if ti in used_t or t.coast < 3:
                        continue
                    best = None
                    for mi, m in enumerate(meas):
                        if mi in used_m:
                            continue
                        d = float(np.hypot(m["x"] - preds[ti][0], m["y"] - preds[ti][1]))
                        if d <= REACQ_GATE_M and (best is None or d < best[0]):
                            best = (d, mi)
                    if best is not None:
                        used_t.add(ti)
                        used_m.add(best[1])
                        matches.append((ti, best[1], best[0]))

        for ti, mi, d in matches:
            t = self.tracks[ti]
            m = meas[mi]
            if d > BLEND_M and t.coast >= 3:
                # controlled snap: too far to glide credibly — jump to the truth,
                # keep the identity, forget the stale velocity
                t.state = np.array([m["x"], m["y"], 0.0, 0.0])
                t.cov = P0.copy()
                t.reacq = 0
            else:
                z = np.array([m["x"], m["y"]])
                Reff = R * (R_BLOWUP if t.reacq > 0 else 1.0)
                innov = z - H_MAT @ t.state
                S = H_MAT @ t.cov @ H_MAT.T + Reff
                K = t.cov @ H_MAT.T @ np.linalg.inv(S)
                t.state = t.state + K @ innov
                t.cov = (np.eye(4) - K @ H_MAT) @ t.cov
                if t.reacq > 0:
                    t.reacq -= 1
            t.coast = 0
            t.age += 1
            t.seen += 1
            t.matches += 1
            if m["team"] is not None:
                t.team = m["team"]
            t.conf = m["conf"]
            t.img = m["img"]

        matched_t = {ti for ti, _, _ in matches}
        for ti, t in enumerate(self.tracks):
            if ti in matched_t:
                continue
            # coasting: keep last velocity, decay it, clamp to the stadium
            t.state[2] *= COAST_DAMP
            t.state[3] *= COAST_DAMP
            x, y = t.state[0], t.state[1]
            if x < X_MIN:
                x, t.state[2] = X_MIN, 0.0
            elif x > X_MAX:
                x, t.state[2] = X_MAX, 0.0
            if y < Y_MIN:
                y, t.state[3] = Y_MIN, 0.0
            elif y > Y_MAX:
                y, t.state[3] = Y_MAX, 0.0
            t.state[0] = x
            t.state[1] = y
            t.coast += 1
            t.age += 1

        if not frozen:
            for mi, m in enumerate(meas):
                if mi in used_m or len(self.tracks) >= MAX_TRACKS:
                    continue
                # spawn-prevention: a measurement near an existing (possibly
                # coasting) track is jitter, not a new player
                near = any(
                    float(np.hypot(m["x"] - t.state[0], m["y"] - t.state[1])) <= SPAWN_GATE_M
                    for t in self.tracks
                )
                if not near:
                    self.tracks.append(
                        _Track(self._next_tid, m["x"], m["y"], m["team"], m["conf"], m["img"])
                    )
                    self._next_tid += 1
            # stale tracks only die while live tracking; a freeze holds everyone.
            # young never-confirmed tracks die fast — they are spawn residue
            self.tracks = [
                t
                for t in self.tracks
                if t.coast <= MAX_COAST and not (t.seen <= 2 and t.coast >= 2)
            ]

        self._merge()
        return self._render()

    def _render(self):
        out = []
        for t in self.tracks:
            if t.age < MIN_AGE:
                continue
            # identity confidence: how established and how consistently matched
            # this track is (0-1). Low confidence = recent/flaky association.
            quality = min(1.0, t.matches / 20.0) * (t.matches / max(t.age, 1))
            out.append(
                {
                    "id": t.tid,
                    "x": float(t.state[0]),
                    "y": float(t.state[1]),
                    "team": t.team,
                    "conf": float(t.conf),
                    "quality": round(float(quality), 2),
                    "img": [float(t.img[0]), float(t.img[1])],
                    "coasting": t.coast > 0,
                }
            )
        return out

    def _merge(self):
        self.tracks.sort(key=lambda t: -t.seen)
        kept = []
        for t in self.tracks:
            dup = False
            for k in kept:
                if (
                    t.coast == 0
                    and k.coast == 0
                    and float(np.hypot(t.state[0] - k.state[0], t.state[1] - k.state[1])) < MERGE_M
                ):
                    k.seen = max(k.seen, t.seen)
                    dup = True
                    break
            if not dup:
                kept.append(t)
        self.tracks = kept
