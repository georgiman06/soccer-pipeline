"""Localhost test bench: SNGS clips + 2D pitch minimap with auto team colors.

Calibration per frame comes from the pitch keypoint model, hardened for
real-time full-clip playback:
  - all temporal state is lock-guarded and strictly sequential; any seek or
    out-of-order request drops the chain instead of smearing across the jump,
  - every homography must pass geometric validation before it can reach the
    renderer (degenerate/mirrored fits are rejected, never drawn),
  - temporal blending only applies to small deviations and the blended result
    is re-validated, so a degenerate matrix lerp can't reach rendering,
  - camera cuts / fast pans are detected via frame differencing: while the
    view is in transition the last trusted snapshot is frozen in place
    (calib_source "frozen") instead of projecting players through a garbage or
    stale homography — no ghost players flying across the pitch; the first
    clean frame after the transition re-anchors immediately.

Run:  python pipeline/server.py   ->   http://127.0.0.1:5000
"""
import json
import os
import sys
import threading
from collections import deque
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, send_file, send_from_directory
from flask_cors import CORS

sys.path.insert(0, str(Path(__file__).parent))
from inference import process_frame, tracker
from pitch_map import PITCH_W, PITCH_H, to_pitch, homography_from_keypoints, TEMPLATE
from teams import TeamClassifier, jersey_color
from player_tracker import PlayerTracker

ROOT = Path(__file__).parent.parent
GS = ROOT / "pitch" / "raw_data" / "gamestate-2024"
WEB = Path(__file__).parent / "web"

# When the AWS_S3_BUCKET_NAME env var is set, fetch data from the bucket instead
USE_BUCKET = bool(os.environ.get("AWS_S3_BUCKET_NAME"))
if USE_BUCKET:
    import bucket as _bucket
    BUCKET_FRAME_PREFIX = "gamestate-2024"

app = Flask(__name__, static_folder=None)
_cors_origins = os.environ.get('CORS_ORIGINS', '*')
CORS(app, resources={r'/api/*': {'origins': _cors_origins}})
_cache = {}
_gt_cache = {}
_last_H = {}      # seq -> (idx, H): last model-validated calibration, for short carries
_H_EMA = {}       # seq -> (idx, H): previous accepted H, only chained when idx == prev+1
_team_ref = {}    # seq -> TeamClassifier
_player_ref = {}  # seq -> PlayerTracker (per-player pitch-space Kalman tracks)
_last_idx = {}    # seq -> last processed frame index (ordering guard)
_last_cand = {}   # seq -> (idx, H): last mid-band candidate, for confirm-before-commit
_ball_smooth = {}  # seq -> (x, y): light pitch-space EMA for the ball dot
_frozen = {}      # seq -> last trusted render snapshot (players/ball pitch positions)
_prev_thumb = {}  # seq -> downsampled gray of previous frame (camera-motion estimate)
_proc_lock = threading.Lock()  # guards all temporal state (Flask serves requests threaded)
_cache_code_v = {}   # seq -> code_v the cache was written with (staleness check for metrics)
KPT_VIS_TH = 0.35
BLEND_DEV_M = 6.0      # below: blend with previous H (meters, at detections); above: new anchor
HOLD_DEV_M = 30.0      # above: mapping disagrees with previous — flip or camera move
CARRY_TTL = 25         # frames a carried homography stays trustworthy (~1 s at 25 fps)
VIEW_CHANGED_PX = 45.0  # median keypoint drift beyond which the view has moved
MOTION_FREEZE = 6.5    # mean frame diff above which jersey sampling is skipped (blur)
FREEZE_MIN_VIS = 5     # keypoints needed to anchor a fresh H right after a transition
CACHE_V = 2             # bump invalidates caches written by older (buggy) chains
CODE_V = 3              # bump when rendering-relevant logic changes (freeze=2, tracker=3)
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# Record import time so the /api/health endpoint can show how long ago the
# worker booted. With 36 cache files in S3 a naive load at startup blew past
# Railway's healthcheck window and gunicorn was killed before serving a
# request — the fix was lazy loading, so this is mostly informational now.
import time as _time
_BOOT_TIME = _time.time()


def _load_cache():
    """Load only already-cached local files. Bucket downloads happen lazily so
    gunicorn workers boot in seconds, not minutes. A 60MB startup download
    reliably exceeds the Railway edge timeout and the worker dies mid-fetch
    — the frontend then sees an HTML 502 instead of JSON.
    """
    for f in CACHE_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict) or data.get("v") != CACHE_V:
            continue
        _ingest_cache_blob(f.stem, data)
    if _cache:
        print(f"loaded {len(_cache)} cached frames from local disk")


def _ingest_cache_blob(seq, data):
    """Merge one cache blob (from local disk OR downloaded bucket object) into
    the in-memory cache. Safe to call repeatedly for the same seq."""
    if not isinstance(data, dict) or data.get("v") != CACHE_V:
        return
    _cache_code_v[seq] = data.get("code_v", 0)
    frames = data.get("frames", {})
    for frame_str, res in frames.items():
        _cache[(seq, int(frame_str))] = res
    if frames:
        total_imgs = _count_frames(seq)
        PRECOMPUTE[seq] = {
            "done": max(int(k) for k in frames),
            "total": total_imgs,
            "finished": len(frames) >= total_imgs,
        }


def _ensure_seq_cache(seq):
    """Download and ingest a single clip's cache from the bucket on first use.
    Idempotent — the second call is a dict lookup. Runs synchronously; expected
    cost: one ~1.7MB S3 GET per seq on cold access, ~50ms on warm."""
    if not USE_BUCKET:
        return
    if any(s == seq for (s, _) in _cache.keys()) or seq in _cache_code_v:
        return  # already loaded
    local_path = CACHE_DIR / f"{seq}.json"
    if local_path.exists() and local_path.stat().st_size > 0:
        try:
            data = json.loads(local_path.read_text())
        except (json.JSONDecodeError, OSError):
            data = None
        if data:
            _ingest_cache_blob(seq, data)
            return
    try:
        bucket_path = _bucket.get_path(f"cache/{seq}.json")
    except FileNotFoundError:
        return
    try:
        data = json.loads(bucket_path.read_text())
    except (json.JSONDecodeError, OSError):
        return
    _ingest_cache_blob(seq, data)


def _persist(seq):
    data = {
        "v": CACHE_V,
        "code_v": CODE_V,
        "frames": {str(idx): res for (s, idx), res in _cache.items() if s == seq},
    }
    (CACHE_DIR / f"{seq}.json").write_text(json.dumps(data))
    if USE_BUCKET:
        try:
            _bucket._client().put_object(
                Bucket=_bucket._bucket(),
                Key=f"cache/{seq}.json",
                Body=json.dumps(data).encode(),
            )
        except Exception:
            pass

# template lines (meters) for the video overlay check
TEMPLATE_LINES = [
    [(0, 0), (105, 0)], [(105, 0), (105, 68)], [(105, 68), (0, 68)], [(0, 68), (0, 0)],
    [(52.5, 0), (52.5, 68)],
    [(0, 13.84), (16.5, 13.84)], [(16.5, 13.84), (16.5, 54.16)], [(16.5, 54.16), (0, 54.16)],
    [(105, 13.84), (88.5, 13.84)], [(88.5, 13.84), (88.5, 54.16)], [(88.5, 54.16), (105, 54.16)],
    [(0, 24.84), (5.5, 24.84)], [(5.5, 24.84), (5.5, 43.16)], [(5.5, 43.16), (0, 43.16)],
    [(105, 24.84), (99.5, 24.84)], [(99.5, 24.84), (99.5, 43.16)], [(105, 43.16), (99.5, 43.16)],
]


def _frame_path(seq, idx):
    """Resolve a frame to a local Path (downloads from bucket if needed)."""
    if USE_BUCKET:
        key = f"{BUCKET_FRAME_PREFIX}/{seq}/img1/{idx:06d}.jpg"
        return _bucket.get_path(key)
    return GS / seq / "img1" / f"{idx:06d}.jpg"


def _frame_bytes(seq, idx):
    """Resolve a frame to bytes (for sending without writing to disk)."""
    if USE_BUCKET:
        key = f"{BUCKET_FRAME_PREFIX}/{seq}/img1/{idx:06d}.jpg"
        try:
            return _bucket.get_bytes(key)
        except Exception:
            return None
    p = GS / seq / "img1" / f"{idx:06d}.jpg"
    if p.exists():
        return p.read_bytes()
    return None


def _count_frames(seq):
    """Count the number of image frames in a sequence."""
    if USE_BUCKET:
        prefix = f"{BUCKET_FRAME_PREFIX}/{seq}/img1/"
        return sum(1 for k in _bucket.list_keys(prefix=prefix) if k.endswith(".jpg"))
    return len(list((GS / seq / "img1").glob("*.jpg")))


def list_sequences():
    if USE_BUCKET:
        # Find all SNGS-* folders in the bucket
        keys = _bucket.list_keys(prefix=f"{BUCKET_FRAME_PREFIX}/")
        seqs = set()
        for k in keys:
            parts = k.split("/")
            if len(parts) >= 4 and parts[-2] == "img1":
                seqs.add(parts[-3])
        return sorted(seqs)
    return sorted(p.name for p in GS.iterdir() if (p / "img1").is_dir())


def gt_for(seq):
    """Parse Labels-GameState.json once: {frame: {'players': [(feet_img, pitch)], 'ball': [(center_img, pitch)]}}."""
    if seq in _gt_cache:
        return _gt_cache[seq]
    if USE_BUCKET:
        gt_bytes = _bucket.get_bytes(f"{BUCKET_FRAME_PREFIX}/{seq}/Labels-GameState.json")
        data = json.loads(gt_bytes)
    else:
        data = json.load(open(GS / seq / "Labels-GameState.json"))
    per_frame = {}
    for ann in data["annotations"]:
        img_id = ann["image_id"]
        frame = int(str(img_id)[-6:])
        bi, bp = ann.get("bbox_image"), ann.get("bbox_pitch")
        if bi is None or bp is None:
            continue
        cat = ann["category_id"]
        if cat == 4:
            img_pt = [bi["x_center"], bi["y_center"]]
        else:
            img_pt = [bi["x_center"], bi["y"] + bi["h"]]
        # bbox_pitch is centered (x in [-52.5,52.5], y in [-34,34]) -> shift to 0-105 / 0-68
        pitch_pt = [bp["x_bottom_middle"] + PITCH_W / 2, bp["y_bottom_middle"] + PITCH_H / 2]
        entry = per_frame.setdefault(frame, {"players": [], "ball": []})
        if cat == 4:
            entry["ball"].append((img_pt, pitch_pt))
        elif cat in (1, 2):
            entry["players"].append((img_pt, pitch_pt))
    _gt_cache[seq] = per_frame
    return per_frame


def gt_homography(seq, idx):
    """RANSAC homography image->pitch from GT correspondences; None if <4 points."""
    gt = gt_for(seq).get(idx)
    if not gt:
        return None
    src, dst = [], []
    for img_pt, pitch_pt in gt["players"] + gt["ball"]:
        src.append(img_pt)
        dst.append(pitch_pt)
    if len(src) < 4:
        return None
    H, _ = cv2.findHomography(np.float32(src), np.float32(dst), cv2.RANSAC, 3.0)
    return H


def homography_to_image(H_pitch):
    """Invert a pitch->... wait: H maps image->pitch; return pitch->image."""
    if H_pitch is None:
        return None
    return np.linalg.inv(H_pitch)


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "use_bucket": USE_BUCKET,
        "cached_frames": len(_cache),
        "uptime_s": round(_time.time() - _BOOT_TIME, 1),
    })


@app.get("/api/sequences")
def api_sequences():
    return jsonify(list_sequences())


@app.get("/api/clips")
def api_clips():
    """Per-clip readiness for the Clip Library UI.

    Status is one of: ready (>=95% of frames cached), partial, cold (not in memory).
    A clip becomes 'partial' or 'ready' only after _ensure_seq_cache has
    downloaded + ingested it; the frontend should call /api/warm_clip for any
    clip it wants to view so the first /api/process call doesn't pay the
    ~1.7MB S3 download + parse cost on the user's critical path.
    """
    seqs = list_sequences()
    out = []
    for seq in seqs:
        cached = sum(1 for (s, _) in _cache.keys() if s == seq)
        total = PRECOMPUTE.get(seq, {}).get("total", 0) or 0
        finished = PRECOMPUTE.get(seq, {}).get("finished", False)
        if finished and total > 0 and cached >= total:
            status = "ready"
        elif cached > 0:
            status = "partial"
        else:
            status = "cold"
        out.append({
            "seq": seq,
            "cached_frames": cached,
            "total_frames": total,
            "precompute_finished": finished,
            "status": status,
        })
    return jsonify(out)


@app.post("/api/warm_clip/<seq>")
def api_warm_clip(seq):
    """Eagerly download + ingest the cache for a single clip.

    Blocks for ~1-2s on a cold connection (one S3 GET), then returns. The
    next /api/process call is instant. Idempotent.
    """
    _ensure_seq_cache(seq)
    cached = sum(1 for (s, _) in _cache.keys() if s == seq)
    return jsonify({"seq": seq, "cached_frames": cached, "ok": True})


@app.get("/api/frame/<seq>/<int:idx>")
def api_frame(seq, idx):
    if USE_BUCKET:
        data = _frame_bytes(seq, idx)
        if data is None:
            return jsonify({"error": "frame not found"}), 404
        return Response(data, mimetype="image/jpeg")
    return send_file(GS / seq / "img1" / f"{idx:06d}.jpg")


@app.get("/api/thumbnail/<seq>")
def api_thumbnail(seq):
    """Small middle-frame JPEG for the Clip Library card preview. ~30KB, fast."""
    if USE_BUCKET:
        mid = max(1, _count_frames(seq) // 2)
        data = _frame_bytes(seq, mid)
        if data is None:
            return jsonify({"error": "frame not found"}), 404
        return Response(data, mimetype="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})
    mid = max(1, len(list((GS / seq / "img1").glob("*.jpg"))) // 2)
    return send_file(GS / seq / "img1" / f"{mid:06d}.jpg")


@app.get("/api/process/<seq>/<int:idx>")
def api_process(seq, idx):
    _ensure_seq_cache(seq)
    key = (seq, idx)
    if key in _cache:
        return jsonify(_cache[key])
    img_path = _frame_path(seq, idx)
    if not img_path.exists():
        return jsonify({"error": "frame not found"}), 404

    _cache[key] = _compute_frame(seq, idx, img_path)
    if idx % 25 == 0:  # rewriting the whole-sequence JSON per frame stutters playback
        _persist(seq)
    return jsonify(_cache[key])


PRECOMPUTE = {}

# background precompute queue: one clip at a time (the GPU is the bottleneck;
# parallel clips would just thrash), resumable across restarts via the cache
_PREQUEUE = deque()
_PREQUEUE_LOCK = threading.Lock()
_PREWORKER_RUNNING = False


def _precompute_seq(seq):
    _ensure_seq_cache(seq)
    total = _count_frames(seq)
    PRECOMPUTE[seq] = {"done": 0, "total": total, "finished": False}
    # drop any out-of-order cached frames and reset the tracker so the
    # sequential pass produces coherent ball tracking
    for key in [k for k in _cache if k[0] == seq]:
        del _cache[key]
    with _proc_lock:
        tracker.reset()
        _H_EMA.pop(seq, None)
        _last_H.pop(seq, None)
        _last_idx.pop(seq, None)
        _team_ref.pop(seq, None)
        _player_ref.pop(seq, None)
        _frozen.pop(seq, None)
        _prev_thumb.pop(seq, None)
        _last_cand.pop(seq, None)
        _ball_smooth.pop(seq, None)
    for idx in range(1, total + 1):
        img_path = _frame_path(seq, idx)
        if not img_path.exists():
            try:
                _bucket.get_path(f"{BUCKET_FRAME_PREFIX}/{seq}/img1/{idx:06d}.jpg")
                img_path = _frame_path(seq, idx)
            except FileNotFoundError:
                break
        if not img_path.exists():
            _cache[(seq, idx)] = _compute_frame(seq, idx, img_path)
        PRECOMPUTE[seq]["done"] = idx
        if idx % 10 == 0:
            _persist(seq)
    _persist(seq)
    PRECOMPUTE[seq]["finished"] = True
    _cache_code_v[seq] = CODE_V


def _queue_worker():
    global _PREWORKER_RUNNING
    while True:
        with _PREQUEUE_LOCK:
            if not _PREQUEUE:
                _PREWORKER_RUNNING = False
                return
            seq = _PREQUEUE.popleft()
        try:
            _precompute_seq(seq)
        except Exception as e:  # one bad clip must not kill the whole queue
            print(f"precompute {seq} failed: {e}")


def _enqueue_precompute(seqs):
    global _PREWORKER_RUNNING
    with _PREQUEUE_LOCK:
        for s in seqs:
            if s not in _PREQUEUE:
                _PREQUEUE.append(s)
        start = not _PREWORKER_RUNNING
        if start:
            _PREWORKER_RUNNING = True
    if start:
        threading.Thread(target=_queue_worker, daemon=True).start()


def _clip_is_current(seq):
    """True when a finished cache exists AND it was written by this code."""
    return PRECOMPUTE.get(seq, {}).get("finished", False) and _cache_code_v.get(seq) == CODE_V


@app.post("/api/precompute/<seq>")
def api_precompute(seq):
    import threading

    if _clip_is_current(seq):
        return jsonify({"already_done": True})
    _enqueue_precompute([seq])
    return jsonify({"started": True})


@app.post("/api/precompute_all")
def api_precompute_all():
    """Queue every clip whose cache is missing or written by older code."""
    todo = [s for s in list_sequences() if not _clip_is_current(s)]
    _enqueue_precompute(todo)
    return jsonify({"queued": len(todo), "clips": todo})


@app.get("/api/queue_status")
def api_queue_status():
    with _PREQUEUE_LOCK:
        queued = list(_PREQUEUE)
    clips = [
        {"seq": s, "done": v.get("done", 0), "total": v.get("total", 0), "finished": v.get("finished", False)}
        for s, v in sorted(PRECOMPUTE.items())
    ]
    return jsonify({"running": _PREWORKER_RUNNING, "queued": queued, "clips": clips})


@app.get("/api/progress/<seq>")
def api_progress(seq):
    _ensure_seq_cache(seq)
    return jsonify(PRECOMPUTE.get(seq, {"done": 0, "total": 0, "finished": False}))


def _compute_frame(seq, idx, img_path):
    # GPU inference runs outside the lock; everything that mutates temporal
    # state (ball Kalman, homography chain) is serialized and strictly ordered.
    r = process_frame(str(img_path))
    h_img, w_img = (int(v) for v in r["pitch"].orig_shape)
    img_bgr = cv2.imread(str(img_path))
    boxes = [(b.xyxy[0].tolist(), float(b.conf)) for b in r["players"].boxes]

    with _proc_lock:
        sequential = _last_idx.get(seq) == idx - 1
        if not sequential:
            # seek / replay / out-of-order request: drop all temporal state so
            # nothing smears across the jump — this is what turned playback of
            # the full stream into chaos before
            tracker.reset()
            _H_EMA.pop(seq, None)
            _last_H.pop(seq, None)
            _frozen.pop(seq, None)
            _prev_thumb.pop(seq, None)
            _player_ref.pop(seq, None)
            _last_cand.pop(seq, None)
            _ball_smooth.pop(seq, None)
        _last_idx[seq] = idx

        # camera-motion estimate: mean abs diff of downsampled gray frames.
        # Separates "static camera, bad fit" (carrying is safe) from
        # "cut / fast pan in progress" (no mapping is trustworthy — freeze).
        thumb = None
        if img_bgr is not None:
            thumb = cv2.cvtColor(
                cv2.resize(img_bgr, (96, 54), interpolation=cv2.INTER_AREA),
                cv2.COLOR_BGR2GRAY,
            )
        prev_thumb = _prev_thumb.get(seq)
        motion = (
            float(np.mean(cv2.absdiff(thumb, prev_thumb)))
            if sequential and thumb is not None and prev_thumb is not None
            else 0.0
        )
        if thumb is not None:
            _prev_thumb[seq] = thumb

        tracked = tracker.update(r["ball"])

        # model-driven calibration from the pitch keypoint model
        kpts = r["pitch"].keypoints
        H = None
        inlier_dst = None  # template points (meters) behind the RANSAC consensus
        n_vis = 0
        n_total = 26
        kpt_px = []
        vis = []
        if kpts is not None:
            data = kpts.data[0]
            vis = data[:, 2] > KPT_VIS_TH
            n_vis = int(vis.sum())
            n_total = kpts.data.shape[1]  # (dets, kpts, xy-conf) -> keypoint count
            kpt_px = kpts.xy[0].tolist()
            H, mask = homography_from_keypoints(kpt_px, vis.tolist(), return_mask=True)
            if H is not None and mask is not None:
                inlier_dst = [TEMPLATE[i] for i, keep in enumerate(mask.ravel().tolist()) if keep]

        # temporal data association: bind detected keypoints to the nearest
        # template point projected through the previous homography, so similar-
        # looking corners can't swap identities frame-to-frame. Only chained
        # when the previous frame is exactly idx-1.
        prev = _H_EMA.get(seq)
        chained = prev is not None and prev[0] == idx - 1 and prev[1] is not None
        if H is not None and chained:
            try:
                Hprev_inv = np.linalg.inv(prev[1] / prev[1][2, 2])
                proj = cv2.perspectiveTransform(
                    np.float32(TEMPLATE).reshape(-1, 1, 2), Hprev_inv
                ).reshape(-1, 2)
                src, dst = [], []
                for i, (xy, v) in enumerate(zip(kpt_px, vis)):
                    if not v:
                        continue
                    d = np.linalg.norm(proj - np.array(xy, dtype=float), axis=1)
                    j = int(np.argmin(d))
                    if d[j] < 80.0:
                        src.append(xy)
                        dst.append(TEMPLATE[j])
                if len(src) >= 4:
                    H2, mask2 = cv2.findHomography(np.float32(src), np.float32(dst), cv2.RANSAC, 1.5)
                    if H2 is not None:
                        H = H2
                        inlier_dst = (
                            [dst[k] for k, keep in enumerate(mask2.ravel().tolist()) if keep]
                            if mask2 is not None
                            else None
                        )
            except (cv2.error, np.linalg.LinAlgError, ValueError):
                pass

        feet_img = [[(x1 + x2) / 2, y2] for (x1, y1, x2, y2), _ in boxes]

        def locally_sane(Hc):
            """Usable where detections are: finite, invertible, doesn't explode
            the detected keypoints, and most players land on the pitch.

            Deliberately weaker than homography_valid: on tight-camera frames a
            4-keypoint fit can be locally excellent while its extrapolation of
            the unseen half of the pitch blows up. Those frames must still
            render; only garbage that scrambles the visible region is rejected.
            """
            if Hc is None or not np.all(np.isfinite(Hc)) or abs(Hc[2, 2]) < 1e-12:
                return False
            Hn = Hc / Hc[2, 2]
            try:
                np.linalg.inv(Hn)
            except np.linalg.LinAlgError:
                return False
            vis_pts = [xy for xy, v in zip(kpt_px, vis) if v]
            if vis_pts:
                proj = cv2.perspectiveTransform(
                    np.float32(vis_pts).reshape(-1, 1, 2), Hn
                ).reshape(-1, 2)
                if not np.all(np.isfinite(proj)) or np.abs(proj).max() > 1e4:
                    return False
                # A "good" homography maps the spread of visible keypoints to
                # a spread of similar magnitude in pitch space. A degenerate
                # fit on a half-pitch view (model sees only 5-8 keypoints all
                # in one corner) collapses pixel x=500..1800 to pitch x=0..5,
                # making all the players pile up on the goal line. Reject any
                # fit that compresses the visible region by more than 10x in
                # either axis — the mapping isn't recoverable from this view.
                if len(proj) >= 2:
                    img_x_range = float(max(p[0] for p in vis_pts) - min(p[0] for p in vis_pts))
                    img_y_range = float(max(p[1] for p in vis_pts) - min(p[1] for p in vis_pts))
                    pitch_x_range = float(np.ptp(proj[:, 0]))
                    pitch_y_range = float(np.ptp(proj[:, 1]))
                    if img_x_range > 100 and pitch_x_range > 0 and pitch_x_range / img_x_range < 0.005:
                        return False
                    if img_y_range > 100 and pitch_y_range > 0 and pitch_y_range / img_y_range < 0.005:
                        return False
                    # Also reject if the pitch range from visible keypoints is
                    # smaller than 5m on a view that should span the pitch —
                    # half-pitch view should still cover 30+ meters
                    if img_x_range > 800 and pitch_x_range < 8:
                        return False
            pp = to_pitch(Hc, feet_img) if feet_img else []
            inside = sum(1 for p in pp if p is not None and -3 <= p[0] <= 108 and -3 <= p[1] <= 71)
            return len(pp) >= 4 and inside / len(pp) >= 0.55

        def local_dev_m(Ha, Hb):
            """Mean disagreement in meters between two Hs where it matters:
            the current frame's keypoints and player feet."""
            samples = [xy for xy, v in zip(kpt_px, vis) if v] + feet_img
            if not samples:
                return float("inf")
            pa = to_pitch(Ha, samples, limit=300.0)
            pb = to_pitch(Hb, samples, limit=300.0)
            ds = [
                float(np.hypot(a[0] - b[0], a[1] - b[1]))
                for a, b in zip(pa, pb)
                if a is not None and b is not None
            ]
            return float(np.mean(ds)) if len(ds) == len(samples) else float("inf")

        cand = H if (H is not None and locally_sane(H)) else None
        source = "none"
        frozen = False

        # does the last trusted calibration still describe what we see? If the
        # visible keypoints have drifted far from where it predicts them, the
        # view has moved (pan/cut) and ANY mapping tied to the old view —
        # carried or held — would scatter players across the pitch.
        # Reference is the anchor H (last model-accepted fit), NOT the previous
        # frame: slow pans drift a couple of px per frame and would otherwise
        # sneak under a per-frame threshold forever while the carry goes stale.
        ref_H = prev[1] if chained else (_last_H.get(seq) or (None, None))[1]
        vis_idx = [i for i, v in enumerate(vis) if v]
        view_changed = False
        if ref_H is not None and vis_idx:
            try:
                Href_inv = np.linalg.inv(ref_H / ref_H[2, 2])
                pred = cv2.perspectiveTransform(
                    np.float32([TEMPLATE[i] for i in vis_idx]).reshape(-1, 1, 2), Href_inv
                ).reshape(-1, 2)
                obs = np.float32([kpt_px[i] for i in vis_idx])
                err = float(np.median(np.linalg.norm(pred - obs, axis=1)))
                view_changed = err > VIEW_CHANGED_PX
            except (cv2.error, np.linalg.LinAlgError, ValueError):
                view_changed = True
        elif ref_H is not None and motion > MOTION_FREEZE:
            view_changed = True  # no reference points and the frame is moving fast
        just_frozen = _frozen.get(seq, {}).get("fidx") == idx - 1

        if cand is not None:
            if chained:
                try:
                    dev_m = local_dev_m(cand, prev[1])
                except (cv2.error, np.linalg.LinAlgError, ZeroDivisionError, ValueError):
                    dev_m = float("inf")
                if dev_m > HOLD_DEV_M:
                    if view_changed:
                        # view moved AND the fresh fit disagrees with the old
                        # mapping: transition in progress — freeze, never hold
                        # a stale H (that's what made players fly everywhere)
                        if seq not in _frozen:
                            cand, source = None, "none"  # nothing trusted yet: blank beat ghosts
                        else:
                            frozen = True
                    else:
                        cand, source = prev[1], "held"  # static camera: mapping still valid
                elif dev_m < BLEND_DEV_M:
                    blended = (0.65 * (cand / cand[2, 2]) + 0.35 * (prev[1] / prev[1][2, 2]))
                    blended = blended / blended[2, 2]
                    # blends may break global conditioning; only take them
                    # when they stay sane where detections live
                    if locally_sane(blended):
                        cand = blended
                    source = "model"
                elif view_changed and n_vis < FREEZE_MIN_VIS and seq in _frozen:
                    frozen = True
                else:
                    # confirm-before-commit: a candidate that disagrees with
                    # the chain is either a real camera move or a hypothesis
                    # flip; only anchor it when it agrees with the previous
                    # mid-band candidate (flips never do, pans always do)
                    lc = _last_cand.get(seq)
                    if lc is not None and idx - lc[0] <= 2 and local_dev_m(cand, lc[1]) < BLEND_DEV_M:
                        _last_cand[seq] = (idx, cand)
                        source = "model"
                    else:
                        _last_cand[seq] = (idx, cand)
                        cand, source = prev[1], "held"
            elif just_frozen:
                source = "model"  # first clean fit after a transition: anchor now
            else:
                source = "model"

        # fit failed: keep freezing through a transition streak (view moved OR
        # we were just frozen — vanished keypoints must not end a freeze and
        # prune every track); otherwise fall back to a short static-camera carry
        if cand is None and (view_changed or just_frozen) and seq in _frozen:
            frozen = True  # fit failed AND the view has moved: hold the snapshot

        if frozen:
            # freeze the last trusted snapshot in place; do NOT touch the H
            # chain, so the first clean frame after the transition anchors fresh
            tracker.reset()  # pixel-space Kalman is meaningless across a cut
            source = "frozen"
        elif cand is None:
            entry = _last_H.get(seq)
            # carrying a stale H across a moved view projects players to wrong
            # spots (they fly across the pitch) — only carry a stable view, and
            # never right after a freeze (the view just changed by definition)
            if (
                entry is not None
                and idx - entry[0] <= CARRY_TTL
                and not view_changed
                and not just_frozen
            ):
                cand, source = entry[1], "carried"
        else:
            if source == "model":
                _last_H[seq] = (idx, cand)
            if source in ("model", "held"):
                _H_EMA[seq] = (idx, cand)

        # single 0-1 field-map confidence for the UI: what the minimap is worth
        # right now (detection and identity confidence live elsewhere)
        if frozen or cand is None:
            h_quality = 0.0
        elif source == "model":
            h_quality = min(1.0, 0.35 + 0.04 * n_vis + 0.03 * len(inlier_dst or []))
        elif source == "held":
            h_quality = 0.55
        else:  # carried
            h_quality = 0.4

        try:
            H_inv = None if frozen else homography_to_image(cand)
        except np.linalg.LinAlgError:
            H_inv = None

        # team kit colors: classify against per-sequence online 2-means so both
        # teams keep stable identities rendered in their real on-pitch colors
        clf = _team_ref.setdefault(seq, TeamClassifier())

        # per-player pitch-space tracks: rendering ALWAYS comes from tracks, so
        # detection jitter and count flicker never reach the minimap. During
        # freezes tracks coast along last velocity (gentle stop) instead of
        # statue-freezing; after a gap they re-lock and blend over a few frames.
        ptrack = _player_ref.setdefault(seq, PlayerTracker())
        if frozen:
            snap = _frozen[seq]
            snap["fidx"] = idx
            ball_img = None
            ball_out = dict(snap["ball"], coasting=True) if snap["ball"] else None
            render = ptrack.update([], frozen=True)
        else:
            players_img = [[(x1 + x2) / 2, y2] for (x1, y1, x2, y2), _ in boxes]
            players_conf = [c for _, c in boxes]
            players_pitch_raw = to_pitch(cand, players_img)
            # blur/cut crops poison the kit-color model — sample stable frames only
            teams = [
                clf.observe(
                    jersey_color(img_bgr, xyxy)
                    if (img_bgr is not None and motion <= MOTION_FREEZE)
                    else None
                )
                for xyxy, _ in boxes
            ]
            meas = [
                {
                    "x": players_pitch_raw[i][0],
                    "y": players_pitch_raw[i][1],
                    "team": teams[i],
                    "conf": players_conf[i],
                    "img": players_img[i],
                }
                for i in range(len(players_img))
                if players_pitch_raw[i] is not None
                # do-no-harm: a "player" mapping 100 m off the pitch is a stale-H
                # artifact, not a player — never let it render or spawn a track
                and -3.0 <= players_pitch_raw[i][0] <= 108.0
                and -3.0 <= players_pitch_raw[i][1] <= 71.0
            ]
            render = ptrack.update(meas, wide_gate=(source == "carried"))

            ball_img = [tracked["x"], tracked["y"]] if tracked else None
            ball_pitch = to_pitch(cand, [ball_img])[0] if ball_img else None
            # light pitch-space EMA: kills ball-dot micro-jitter without lagging
            # real kicks (large jumps snap instead of blend)
            if ball_pitch is not None:
                prev_b = _ball_smooth.get(seq)
                if (
                    prev_b is not None
                    and abs(ball_pitch[0] - prev_b[0]) + abs(ball_pitch[1] - prev_b[1]) < 15.0
                ):
                    ball_pitch = (
                        0.55 * ball_pitch[0] + 0.45 * prev_b[0],
                        0.55 * ball_pitch[1] + 0.45 * prev_b[1],
                    )
                _ball_smooth[seq] = ball_pitch
            if source in ("model", "held", "carried"):
                _frozen[seq] = {
                    "idx": idx,
                    "ball": (
                        {"pitch": ball_pitch, "coasting": False, "conf": tracked["conf"]}
                        if tracked and ball_pitch is not None
                        else None
                    ),
                }
            ball_out = (
                {
                    "img": [round(v, 1) for v in ball_img],
                    "pitch": ball_pitch,
                    "coasting": tracked["coasting"],
                    "conf": round(tracked["conf"], 2),
                }
                if tracked
                else None
            )
        team_colors = clf.hex_colors()

    gt = gt_for(seq).get(idx, {"players": [], "ball": []})
    gt_players_img = [p[0] for p in gt["players"]]
    gt_players_pitch = [p[1] for p in gt["players"]]
    gt_ball_img = [p[0] for p in gt["ball"]]
    gt_ball_pitch = [p[1] for p in gt["ball"]]

    overlay = []
    if H_inv is not None:
        m_x, m_y = w_img + 60.0, h_img + 60.0
        for line in TEMPLATE_LINES:
            pts = to_pitch(H_inv, line, limit=5000.0)
            # a locally-good fit can still extrapolate wildly outside the
            # visible frame — never draw segments whose endpoints left it
            if all(p is not None and -60.0 <= p[0] <= m_x and -60.0 <= p[1] <= m_y for p in pts):
                overlay.append([[round(p[0], 1), round(p[1], 1)] for p in pts])

    out = {
        "seq": seq,
        "idx": idx,
        "calib_source": source,
        "h_quality": round(h_quality, 2),
        "kpts": {"visible": n_vis, "total": n_total},
        "players": [
            {
                "img": [round(p["img"][0], 1), round(p["img"][1], 1)],
                "pitch": [round(p["x"], 2), round(p["y"], 2)],
                "conf": round(p["conf"], 2),
                "team": p["team"],
                "coasting": p["coasting"],
                "id": p["id"],
                "quality": p["quality"],
            }
            for p in render
        ],
        "team_colors": team_colors,
        "ball": ball_out,
        "gt": {
            "players_img": gt_players_img,
            "players_pitch": gt_players_pitch,
            "ball_img": gt_ball_img,
            "ball_pitch": gt_ball_pitch,
        },
        "overlay_lines": overlay,
    }
    return out


if __name__ == "__main__":
    _load_cache()
    port = int(os.environ.get("PORT", 5000))
    host = "0.0.0.0" if os.environ.get("RAILWAY_ENVIRONMENT") else "127.0.0.1"
    print("sequences:", len(list_sequences()))
    print(f"serving on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
