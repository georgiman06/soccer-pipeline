"""Unified inference pipeline: ball + player + pitch-keypoint models in one call."""
from pathlib import Path

from ultralytics import YOLO

from ball_tracker import BallTracker

MODELS_DIR = Path(__file__).parent.parent / "models"

ball_model = YOLO(MODELS_DIR / "ball_best.pt")
pitch_model = YOLO(MODELS_DIR / "pitch_best_ft.pt")
players_model = YOLO(MODELS_DIR / "players_best.pt")

CONF = 0.3
tracker = BallTracker(conf_threshold=CONF)


def process_frame(frame):
    """Run all three models on one frame (path or image array).

    Returns dict with raw ultralytics Results for each model.
    """
    return {
        "ball": ball_model.predict(frame, conf=CONF, imgsz=1280, verbose=False)[0],
        "pitch": pitch_model.predict(frame, conf=CONF, imgsz=960, verbose=False)[0],
        "players": players_model.predict(frame, conf=CONF, imgsz=960, verbose=False)[0],
    }


def process_frame_tracked(frame):
    """process_frame + Kalman-smoothed ball position (survives missed frames)."""
    results = process_frame(frame)
    results["ball_tracked"] = tracker.update(results["ball"])
    return results


def summarize(results):
    """Human-readable per-model summary of a process_frame result."""
    out = {}
    out["ball"] = [
        {"conf": round(float(b.conf), 2), "xyxy": [round(v, 1) for v in b.xyxy[0].tolist()]}
        for b in results["ball"].boxes
    ]
    out["players"] = [
        {"conf": round(float(b.conf), 2), "xyxy": [round(v, 1) for v in b.xyxy[0].tolist()]}
        for b in results["players"].boxes
    ]
    kpts = results["pitch"].keypoints
    out["pitch_keypoints"] = (
        {
            "visible": int((kpts.data[0][:, 2] > 0.5).sum().item()),
            "total": kpts.data.shape[1],
            "xy": kpts.xy[0].tolist(),
        }
        if kpts is not None
        else None
    )
    return out


if __name__ == "__main__":
    import glob

    frame = sorted(glob.glob(str(MODELS_DIR.parent / "players" / "dataset_stride2" / "train" / "images" / "*.jpg")))[0]
    print("frame:", frame)
    results = process_frame(frame)
    s = summarize(results)
    print(f"ball detections: {len(s['ball'])}")
    print(f"player detections: {len(s['players'])}")
    if s["pitch_keypoints"]:
        print(f"pitch keypoints visible: {s['pitch_keypoints']['visible']}/{s['pitch_keypoints']['total']}")
