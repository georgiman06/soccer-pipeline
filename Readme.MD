# Soccer AI Pipeline — Pitch, Ball & Player Detection

## What we're building

Three independent YOLO models trained on SoccerNet data, later combined into a single
inference pipeline that plugs into the existing soccer UI project:

1. **Ball detection** — bounding box, YOLOv8 detect
2. **Player detection** — bounding box, YOLOv8 detect
3. **Pitch keypoint detection** — pose/keypoint, YOLOv8-pose

No Roboflow account, deploy, or hosting is used anywhere in this pipeline. Training runs
locally or in Google Colab; trained weights (`best.pt`) are the only deliverable per task
and get downloaded/saved to Google Drive.

## Working style / tooling

- Use whatever skills are already enabled in this Claude Code environment (e.g. `caveman`)
  to keep responses terse and token-efficient — no need for verbose explanations, restating
  the plan, or re-summarizing this README back. Just do the work for the current stage and
  report results plainly.
- Prefer short, direct status updates over long write-ups: what ran, what passed/failed,
  what's needed next.

## Ground rules

- Work **one stage at a time, one task at a time**. Do not start Stage 2 until Stage 1 is
  fully verified working. Do not start Players or Pitch until Ball is fully trained and
  producing a valid `best.pt`.
- Every task gets its own self-contained folder — no shared code between tasks until the
  final pipeline stage.
- Every stage should end with something concrete and verifiable (a file, a working script,
  a trained model) before moving to the next.

## Project structure

```
soccer_project/
  ball/
    raw_data/                 <- downloaded SoccerNet data for this task
    dataset/
      train/images/  train/labels/
      valid/images/  valid/labels/
    data.yaml
    weights/best.pt            <- produced by Stage 4 (Training)
  pitch/
    (same structure as ball/)
  players/
    (same structure as ball/)
  pipeline/
    inference.py                <- Stage 6 only, combines all 3 models
  models/
    ball_best.pt
    pitch_best.pt
    players_best.pt
```

---

## STAGE 0 — Environment setup

**Goal:** Confirm Python environment, GPU access, and required packages before touching data.

- [ ] Decide once: training locally or in Google Colab. Do not switch mid-project.
- [ ] Install: `ultralytics`, `SoccerNet` (pip package), `opencv-python`
- [ ] If Colab: confirm GPU is enabled (`!nvidia-smi`)
- [ ] Create the `soccer_project/` folder structure above (empty folders are fine for now)

**Done when:** `import ultralytics` and `from SoccerNet.Downloader import SoccerNetDownloader`
both run with no errors.

---

## STAGE 1 — Ball detection: data acquisition

**Goal:** Download the relevant SoccerNet subset for ball detection into `ball/raw_data/`.

- [ ] Register for SoccerNet access at soccer-net.org (free, request password by email)
- [ ] Use `SoccerNetDownloader` to pull the relevant task/split into `ball/raw_data/`
- [ ] Confirm the raw annotation format (inspect a sample file — SoccerNet ships JSON, not
      YOLO `.txt`)

**Done when:** `ball/raw_data/` contains real downloaded files and you know exactly what
format the labels are in.

---

## STAGE 2 — Ball detection: label conversion

**Goal:** Convert SoccerNet's JSON annotations into YOLO `.txt` format, split into
train/valid, and produce a valid `data.yaml`.

- [ ] Write a conversion script: SoccerNet JSON → YOLO `.txt` (`class x_center y_center width height`, normalized 0–1)
- [ ] Split into `ball/dataset/train/` and `ball/dataset/valid/` (roughly 80/20)
- [ ] Write `ball/dataset/data.yaml`:
  ```yaml
  train: ../train/images
  val: ../valid/images
  nc: 1
  names: ['ball']
  ```
- [ ] Spot-check: pick 2–3 images, draw the converted boxes back onto the image, confirm
      they land in the right place visually

**Done when:** every image in `train/images` and `valid/images` has a matching `.txt` file
in the corresponding `labels/` folder, and the spot-check boxes look correct.

---

## STAGE 3 — Ball detection: training

**Goal:** Fine-tune `yolov8x.pt` on the converted ball dataset.

```python
from ultralytics import YOLO

model = YOLO("yolov8x.pt")
model.train(
    data="ball/dataset/data.yaml",
    epochs=50,
    imgsz=1280,
    batch=8,
    patience=20
)
```

- [ ] Confirm training completes without errors
- [ ] Check `results.png` — validation loss should trend down, not diverge from train loss
- [ ] Save the resulting `best.pt` to `ball/weights/best.pt` and back it up to Google Drive
      immediately (Colab sessions wipe on disconnect)

**Done when:** `ball/weights/best.pt` exists and is backed up to Drive.

---

## STAGE 4 — Repeat Stages 1–3 for Players

Same process, `players/` folder, base model `yolov8x.pt`, one class (`player`).
Do not start this until Ball's `best.pt` is confirmed working.

---

## STAGE 5 — Repeat Stages 1–3 for Pitch (keypoints)

Same process, `pitch/` folder, base model `yolov8x-pose.pt`. This one is different:
labels need keypoint coordinates (pitch corners, center circle, box corners, etc.), not
just a bounding box — confirm SoccerNet-Calibration's exact keypoint schema before writing
the conversion script. Do not start this until Players' `best.pt` is confirmed working.

---

## STAGE 6 — Unified inference pipeline

**Goal:** Combine all three trained models into one pipeline that can be called from the
soccer UI project.

- [ ] Copy all three `best.pt` files into `models/` (renamed `ball_best.pt`,
      `players_best.pt`, `pitch_best.pt`)
- [ ] Write `pipeline/inference.py`:
  ```python
  from ultralytics import YOLO

  ball_model = YOLO("models/ball_best.pt")
  pitch_model = YOLO("models/pitch_best.pt")
  players_model = YOLO("models/players_best.pt")

  def process_frame(frame):
      return {
          "ball": ball_model.predict(frame, verbose=False)[0],
          "pitch": pitch_model.predict(frame, verbose=False)[0],
          "players": players_model.predict(frame, verbose=False)[0],
      }
  ```
- [ ] Test `process_frame()` on a single sample frame from one of the 30-sec clips
- [ ] Wire this into the soccer UI project

**Done when:** a single function call returns predictions from all three models on one
frame, ready to be consumed by the UI.

---

## Notes

- Do not use Roboflow's `.deploy()` / hosted inference anywhere in this pipeline — training
  and inference both run locally against `best.pt` files.
- Every stage should be committed/saved before moving to the next — don't let three tasks'
  worth of unsaved progress build up in one Colab session.

---

# PHASE 2 — Live 2D match view (current work)

## Status (as of 2026-08-25)

All training stages done. `pipeline/server.py` is a localhost test bench
(`python pipeline/server.py` → http://127.0.0.1:5000) that runs all three models per frame,
tracks the ball (pixel-space Kalman), maps everything to pitch meters via the keypoint
homography, auto-detects both teams' kit colors (online 2-means on torso crops, `pipeline/teams.py`),
and renders a 2D minimap + video overlay. Clips precompute (~35 min / 750 frames) then play
at native 25 fps.

Hardened for full-clip playback:
- Lock-guarded, strictly sequential temporal state; seeks/replays drop the chain cleanly
- Two-tier homography validation (global `homography_valid` + local sanity at detections)
- Blends only small deviations, re-validated; degenerate matrix lerps can't reach the renderer
- Overlay lines clipped to the visible frame
- **Camera-transition freeze**: when the visible keypoints drift from what the last anchored
  calibration predicts (`view_changed`), the minimap holds the last trusted snapshot
  (`calib_source: frozen`) instead of projecting players through a garbage/stale homography.
  First clean frame after the transition re-anchors immediately. Freeze is confidence-
  triggered (calibration quality), NOT motion-triggered — good pans with solid fits track live.
- Carrying a stale homography is blocked whenever the view moved (this was the ghost-player source)
- Verified: SNGS-028 f88–175 (freeze holds pixel-exact f97–f151, instant re-anchor at f152,
  smooth 0.3–0.9 m/frame after); SNGS-021 stable-segment regression unchanged.

## Release sequence (agreed plan)

1. **Verify freeze behavior end-to-end → push to GitHub** (basic demo)
2. **Frontend UI polish** — intuitive, clean, user-ready
3. **Railway deployment** — when the demo is good enough for a basic user
4. **New branch** for the deeper implementation work (this week)

## Milestones (from design review — do not forget)

- **M1 — Metrics/regression script** ✅ DONE (`pipeline/metrics.py`): measures teleports,
  off-pitch markers, jitter, recovery latency, count stability, blank frames, calibration
  coverage. Run `python pipeline/metrics.py` (cached clips) or
  `python pipeline/metrics.py SNGS-028 --live 92:160` (fresh, current code — caches are
  stamped with `code_v`; stale caches are flagged). Report: `pipeline/metrics_report.json`.
  Current status: SNGS-021 stable window PASS (jitter 0.36 m median), SNGS-028 transition
  window PASS (0 teleports, 0 off-pitch, recovery 1 frame).
- **M2 — Per-player pitch-space Kalman** ✅ DONE (`pipeline/player_tracker.py`): identity
  association in meter space (2 m gate → 6 m re-lock tier → 25 m recovery tier), coasting
  through freezes with velocity decay (gentle stop, tracks never die mid-freeze),
  reconciliation on recovery (blend < 12 m, controlled snap beyond — no ghost-glides),
  spawn-prevention, young-track fast death, confirm-before-commit for mid-band homography
  anchors (kills the A/B hypothesis flip-flop at the source). Measured: stable counts,
  0.2–1.8 m/frame jitter in stable play, natural glide through transitions.
- **M3 — Uncertainty styling** ✅ DONE: coasted players at 50% alpha, frozen-mode dots at
  75%, `REACQUIRING` badge + field-map confidence (`map NN%`) in the status bar.
- **M4 — Calibration quality** ◐ PARTIAL: formal H-quality scoring is effectively embedded
  (locally_sane, RANSAC inliers, view_changed drift, confirm-before-commit, `h_quality` in
  payload). **Tested and falsified (2026-08-25): lowering pitch-model conf 0.3→0.15 unlocks
  ZERO extra keypoints on starved frames** (SNGS-021 f50–250, SNGS-028 pan) — the model
  doesn't see the features at all. Real fix is training-side: add tight/zoomed +
  motion-blurred frames to `pitch/dataset_ft` and re-run `finetune_colab.ipynb`. Do not
  re-test inference thresholds.
- **M5 — Player identities** ◐ DONE at tracker level (`player_tracker.py`): stable `id`
  per track (survives freezes/gaps via coasting + re-lock), identity `quality` 0–1
  (established × match-rate), optional ID labels in the UI. Full visual re-ID (jersey/
  appearance matching after long absences) = feature-branch work.

**Also done tonight:** ball pitch-space EMA (no more ball-dot micro-jitter), playback speed
selector (0.5x/1x/2x), off-pitch measurement rejection (do-no-harm), display-box clamping.

Explicitly NOT planned: optical-flow homography bridging, RTS smoothers, Kalman-on-H —
complexity without user-visible payoff at this stage.

## V1 success criteria (measurable)

- No player teleports across the pitch in 1–2 frames
- No player marker maps substantially outside the pitch
- During hard camera motion the 2D view degrades gracefully (freeze/coast), never chaotic
- Tracking recovers within a short, consistent interval after a cut/pan
- A normal viewer watching a 30 s clip says the map is "trustworthy enough to follow play"

## Ops notes

- Flask runs with `debug=False` → restart the server after code changes (no hot reload)
- `pipeline/cache/*.json` caches precomputed results (schema v2 + `code_v` stamp); delete a
  clip's file to force re-precompute after logic changes
- **Background precompute of the whole library**: `POST /api/precompute_all` (or the
  "Precompute ALL" button) queues every clip whose cache is missing or written by older
  code; one clip at a time, ~6–7 min each (~6–7 h for all 59). Progress: `GET /api/queue_status`
  or the status bar. Resumable — restart the server and press it again; finished/current
  clips are skipped. Bumping `CODE_V` in `server.py` invalidates all caches on next run.
- Thresholds (`BLEND_DEV_M`, `HOLD_DEV_M`, `VIEW_CHANGED_PX`, `CARRY_TTL`, `MOTION_FREEZE`,
  `FREEZE_MIN_VIS` in `server.py`) are starting points — tune against the clip set, not one video