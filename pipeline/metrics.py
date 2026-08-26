"""M1 — V1 success-criteria metrics for the 2D pitch rendering.

Measures a clip (from cache or freshly computed) against the agreed criteria:
  - no player teleports during stable calibration stretches
  - no rendered marker lands off the pitch
  - calibration recovers within a few frames after transitions
  - low jitter and stable track counts while tracking is healthy

Usage:
  python pipeline/metrics.py                          # measure all cached clips
  python pipeline/metrics.py SNGS-028 --live 92:160   # fresh compute (current code)
  python pipeline/metrics.py SNGS-021 --live 295:335 --live 400:440

Writes pipeline/metrics_report.json and prints a PASS/FAIL table.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

RECOVERY_FRAMES = 6        # frames after a calibration change counted as reacquisition
STABLE_TELEPORT_M = 6.0    # stable-stretch jump above this = teleport violation
OFF_PITCH = (-3.0, 108.0, -3.0, 71.0)
STABLE_JITTER_TARGET = 2.5
RECOVERY_LATENCY_TARGET = 3
COUNT_SPREAD_TARGET = 6
USABLE = {"model", "held", "carried"}

CODE_V = 3  # keep in sync with server.CODE_V


def frames_from_cache(seq):
    f = Path(__file__).parent / "cache" / f"{seq}.json"
    if not f.exists():
        return None, None
    data = json.loads(f.read_text())
    if data.get("v") != 2:
        return None, None
    code_v = data.get("code_v", 0)
    frames = {int(k): v for k, v in data.get("frames", {}).items()}
    return frames, code_v


def frames_live(seq, ranges):
    import server

    out = {}
    total = sum(b - a + 1 for a, b in ranges)
    done = 0
    t0 = time.time()
    for a, b in ranges:
        for idx in range(a, b + 1):
            p = server.GS / seq / "img1" / f"{idx:06d}.jpg"
            if not p.exists():
                continue
            out[idx] = server._compute_frame(seq, idx, p)
            done += 1
            if done % 10 == 0:
                el = time.time() - t0
                print(f"  {done}/{total} frames ({el:.0f}s elapsed, ~{(total - done) * el / max(done, 1):.0f}s left)", flush=True)
    return out


def measure(frames):
    idxs = sorted(frames)
    calib = [frames[i]["calib_source"] for i in idxs]
    # rendered positions per frame (what the minimap actually shows)
    pts = {
        i: np.array(
            [[p["pitch"][0], p["pitch"][1]] for p in frames[i]["players"] if p.get("pitch")],
            dtype=float,
        )
        for i in idxs
    }
    counts = {i: len(pts[i]) for i in idxs}

    off_pitch = 0
    for i in idxs:
        for p in frames[i]["players"]:
            q = p.get("pitch")
            if q and not (OFF_PITCH[0] <= q[0] <= OFF_PITCH[1] and OFF_PITCH[2] <= q[1] <= OFF_PITCH[3]):
                off_pitch += 1

    # context: stable iff the whole recent window is model-calibrated
    stable_since = 0
    stable_jumps, trans_jumps = [], []
    teleports = 0
    prev = None
    for n, i in enumerate(idxs):
        stable = calib[n] == "model" and stable_since >= RECOVERY_FRAMES
        cur = pts[i]
        if prev is not None and len(cur) and len(prev):
            d = float(np.median(np.min(np.linalg.norm(cur[:, None] - prev[None, :], axis=2), axis=1)))
            (stable_jumps if stable else trans_jumps).append(d)
            if stable and d > STABLE_TELEPORT_M:
                teleports += 1
        stable_since = stable_since + 1 if calib[n] == "model" else 0
        prev = cur

    # frozen/none streaks and recovery latency (first model frame after a run)
    streaks, latencies = [], []
    n = 0
    while n < len(idxs):
        if calib[n] in ("frozen", "none"):
            s = n
            while n < len(idxs) and calib[n] in ("frozen", "none"):
                n += 1
            streaks.append(n - s)
            lat = next((k for k in range(n, min(n + 10, len(idxs))) if calib[k] == "model"), None)
            if lat is not None:
                latencies.append(lat - n + 1)
        else:
            n += 1

    stable_counts = [counts[i] for k, i in enumerate(idxs) if calib[k] == "model" and stable_since_at(idxs, calib, k) >= RECOVERY_FRAMES]
    cov = {
        "usable": sum(1 for c in calib if c in USABLE),
        "frozen": sum(1 for c in calib if c == "frozen"),
        "none": sum(1 for c in calib if c == "none"),
    }
    blank_usable = sum(1 for k, i in enumerate(idxs) if calib[k] in USABLE and counts[i] == 0)

    # prediction accuracy vs ground truth (GT = SoccerNet's calibrated annotations):
    # median distance from each predicted player to its nearest GT player
    gt_d, ball_d = [], []
    within2 = 0
    total_preds = 0
    for i in idxs:
        gt_p = frames[i].get("gt", {}).get("players_pitch") or []
        if gt_p and len(pts[i]):
            g = np.array(gt_p, dtype=float)
            for q in pts[i]:
                d = float(np.min(np.linalg.norm(g - q, axis=1)))
                gt_d.append(d)
                total_preds += 1
                within2 += d <= 2.0
        gtb = frames[i].get("gt", {}).get("ball_pitch") or []
        ball = frames[i].get("ball")
        bp = ball.get("pitch") if ball else None
        if gtb and bp is not None:
            g = np.array(gtb, dtype=float)
            ball_d.append(float(np.min(np.linalg.norm(g - np.array(bp), axis=1))))

    return {
        "frames": len(idxs),
        "coverage_pct": {k: round(100 * v / max(len(idxs), 1), 1) for k, v in cov.items()},
        "teleports_stable": teleports,
        "off_pitch_markers": off_pitch,
        "jitter_median_m": round(float(np.median(stable_jumps)), 2) if stable_jumps else None,
        "jitter_p95_m": round(float(np.percentile(stable_jumps, 95)), 2) if stable_jumps else None,
        "transition_jump_median_m": round(float(np.median(trans_jumps)), 2) if trans_jumps else None,
        "frozen_streaks": streaks,
        "frozen_streak_max": max(streaks) if streaks else 0,
        "recovery_latency_frames": latencies,
        "recovery_latency_p95": int(np.percentile(latencies, 95)) if latencies else None,
        "count_median": int(np.median(stable_counts)) if stable_counts else 0,
        "count_spread_p95": int(np.percentile(stable_counts, 95) - np.median(stable_counts)) if stable_counts else 0,
        "blank_usable_frames": blank_usable,
        "pred_gt_median_m": round(float(np.median(gt_d)), 2) if gt_d else None,
        "pred_gt_p90_m": round(float(np.percentile(gt_d, 90)), 2) if gt_d else None,
        "pred_within_2m_pct": round(100 * within2 / max(total_preds, 1), 1) if total_preds else None,
        "ball_gt_median_m": round(float(np.median(ball_d)), 2) if ball_d else None,
    }


def stable_since_at(idxs, calib, k):
    s = 0
    while k - s >= 0 and calib[k - s] == "model":
        s += 1
    return s


def verdict(m, first_idx=None):
    jitter_ok = m["jitter_median_m"] is None or m["jitter_median_m"] <= STABLE_JITTER_TARGET
    jitter_detail = "n/a (no stable stretch)" if m["jitter_median_m"] is None else f'{m["jitter_median_m"]} m'
    # a fresh window has no tracks yet for its first frames — not a real gap
    blanks = m["blank_usable_frames"] if m["blank_usable_frames"] > 2 else 0
    rows = [
        ("no stable teleports", m["teleports_stable"] == 0, f'{m["teleports_stable"]} violations'),
        ("no off-pitch markers", m["off_pitch_markers"] == 0, f'{m["off_pitch_markers"]} markers'),
        (f"jitter median <= {STABLE_JITTER_TARGET} m", jitter_ok, jitter_detail),
        (f"recovery latency p95 <= {RECOVERY_LATENCY_TARGET} frames", (m["recovery_latency_p95"] is None) or m["recovery_latency_p95"] <= RECOVERY_LATENCY_TARGET, f'{m["recovery_latency_p95"]}'),
        (f"count spread p95 <= {COUNT_SPREAD_TARGET}", m["count_spread_p95"] <= COUNT_SPREAD_TARGET, f'{m["count_spread_p95"]}'),
        ("no blank frames while usable", blanks == 0, f'{blanks} blank'),
    ]
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("seqs", nargs="*")
    ap.add_argument("--live", action="append", default=[], help="frame range a:b, fresh compute with current code")
    args = ap.parse_args()

    import server  # noqa: F401  (model load)

    seqs = args.seqs or sorted(server.list_sequences())
    report = {}
    for seq in seqs:
        if args.live:
            ranges = [tuple(int(v) for v in r.split(":")) for r in args.live]
            print(f"[{seq}] computing live frames {ranges} with current code (CODE_V={CODE_V})...", flush=True)
            frames = frames_live(seq, ranges)
            code_v = CODE_V
            src = "live"
        else:
            frames, code_v = frames_from_cache(seq)
            src = "cache"
            if not frames:
                print(f"[{seq}] no usable cache — use --live a:b")
                continue
        m = measure(frames)
        m["source"] = src
        m["code_v"] = code_v
        m["stale"] = code_v < CODE_V
        report[seq] = m

        print(f"\n=== {seq} ({src}, code_v={code_v}{' STALE — re-precompute!' if m['stale'] else ''}) ===")
        print(f"coverage: {m['coverage_pct']}  frozen streaks: {m['frozen_streaks']}")
        print(f"jitter: median {m['jitter_median_m']} m / p95 {m['jitter_p95_m']} m | transition median {m['transition_jump_median_m']} m")
        ok_all = True
        for name, ok, detail in verdict(m):
            ok_all &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
        print(f"  accuracy vs GT: players median {m['pred_gt_median_m']} m (p90 {m['pred_gt_p90_m']} m, within 2 m: {m['pred_within_2m_pct']}%) | ball median {m['ball_gt_median_m']} m")
        if m["stale"]:
            print("  [WARN] cache written by older code — results do not reflect current pipeline")
        print(f"  => {'PASS' if ok_all and not m['stale'] else 'FAIL'}\n")

    out = Path(__file__).parent / "metrics_report.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"report written: {out}")


if __name__ == "__main__":
    main()
