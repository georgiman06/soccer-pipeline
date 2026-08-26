"""Evaluate model-keypoint homography vs GT: player position error in meters."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from ultralytics import YOLO
from pitch_map import homography_from_keypoints, to_pitch

GS = Path(__file__).parent.parent / "pitch" / "raw_data" / "gamestate-2024"
pitch_m = YOLO("../models/pitch_best_ft.pt")
players_m = YOLO("../models/players_best.pt")


def gt_pairs(labels, frame):
    out = []
    for ann in labels["annotations"]:
        if int(str(ann["image_id"])[-6:]) != frame:
            continue
        bi, bp = ann.get("bbox_image"), ann.get("bbox_pitch")
        if bi is None or bp is None or ann["category_id"] not in (1, 2):
            continue
        out.append(([bi["x_center"], bi["y"] + bi["h"]],
                    [bp["x_bottom_middle"] + 52.5, bp["y_bottom_middle"] + 34.0]))
    return out


def evaluate(seq, frame):
    img_path = GS / seq / "img1" / f"{frame:06d}.jpg"
    r = pitch_m.predict(str(img_path), conf=0.05, imgsz=960, verbose=False)[0]
    k = r.keypoints
    if k is None:
        return None
    data = k.data[0]
    vis = (data[:, 2] > 0.5).tolist()
    n_vis = int(sum(vis))
    H = homography_from_keypoints(k.xy[0].tolist(), vis)
    if H is None:
        return {"seq": seq, "frame": frame, "kpts": n_vis, "H": False, "err": None}

    rp = players_m.predict(str(img_path), conf=0.3, verbose=False)[0]
    pred_img = []
    for b in rp.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        pred_img.append([(x1 + x2) / 2, y2])
    pred_pitch = to_pitch(H, pred_img)

    labels = json.load(open(GS / seq / "Labels-GameState.json"))
    gt = gt_pairs(labels, frame)
    gt_pitch = np.array([g[1] for g in gt])

    errs = []
    for p in pred_pitch:
        if p is None or len(gt_pitch) == 0:
            continue
        d = np.linalg.norm(gt_pitch - np.array(p), axis=1)
        errs.append(d.min())
    return {"seq": seq, "frame": frame, "kpts": n_vis, "H": True,
            "err": float(np.mean(errs)) if errs else None, "n_pred": len(errs)}


if __name__ == "__main__":
    cases = [
        ("SNGS-031", 715), ("SNGS-031", 400), ("SNGS-033", 150),
        ("SNGS-035", 287), ("SNGS-052", 150), ("SNGS-078", 300),
        ("SNGS-091", 500), ("SNGS-024", 600),
    ]
    all_err = []
    for seq, frame in cases:
        r = evaluate(seq, frame)
        if r is None:
            print(f"{seq} {frame}: no keypoints at all")
        elif not r["H"]:
            print(f"{seq} {frame}: kpts={r['kpts']} (<4, no homography)")
        else:
            e = r["err"]
            all_err.append(e)
            print(f"{seq} {frame}: kpts={r['kpts']:2}  mean player err = {e:.2f} m  ({r['n_pred']} players)")
    if all_err:
        print(f"\noverall mean error: {np.mean(all_err):.2f} m over {len(all_err)} frames")
