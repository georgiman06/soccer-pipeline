"""Build a pitch-keypoint fine-tune dataset from SNGS clips + GT homographies.

For each sampled frame: fit image->pitch homography from GT player/ball correspondences
(Labels-GameState.json bbox_image <-> bbox_pitch), invert it, project the pitch template
lines into the image, then derive the 26 keypoints with the same intersection logic used
for the original calibration-2023 dataset.
"""
import json
import random
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
from convert_labels import build_keypoints
from pitch_map import PITCH_H, PITCH_W, GOAL_W, PEN_D, PEN_W, GOAL_AREA_D, GOAL_AREA_W, to_pitch

GS = Path(__file__).parent / "raw_data" / "gamestate-2024"
OUT = Path(__file__).parent / "dataset_ft"
FRAME_STRIDE = 5
CLIP_VALID_FRACTION = 0.12
SEED = 42
MIN_CORRESPONDENCES = 6
MIN_VISIBLE_KPTS = 6

pen_y = (PITCH_H - PEN_W) / 2
goal_y = (PITCH_H - GOAL_AREA_W) / 2
gy = PITCH_H / 2

TEMPLATE_LINES = {
    "Side line top": [(0, 0), (PITCH_W, 0)],
    "Side line bottom": [(0, PITCH_H), (PITCH_W, PITCH_H)],
    "Side line left": [(0, 0), (0, PITCH_H)],
    "Side line right": [(PITCH_W, 0), (PITCH_W, PITCH_H)],
    "Big rect. left top": [(0, pen_y), (PEN_D, pen_y)],
    "Big rect. left main": [(PEN_D, pen_y), (PEN_D, PITCH_H - pen_y)],
    "Big rect. left bottom": [(0, PITCH_H - pen_y), (PEN_D, PITCH_H - pen_y)],
    "Big rect. right top": [(PITCH_W, pen_y), (PITCH_W - PEN_D, pen_y)],
    "Big rect. right main": [(PITCH_W - PEN_D, pen_y), (PITCH_W - PEN_D, PITCH_H - pen_y)],
    "Big rect. right bottom": [(PITCH_W, PITCH_H - pen_y), (PITCH_W - PEN_D, PITCH_H - pen_y)],
    "Small rect. left top": [(0, goal_y), (GOAL_AREA_D, goal_y)],
    "Small rect. left main": [(GOAL_AREA_D, goal_y), (GOAL_AREA_D, PITCH_H - goal_y)],
    "Small rect. left bottom": [(0, PITCH_H - goal_y), (GOAL_AREA_D, PITCH_H - goal_y)],
    "Small rect. right top": [(PITCH_W, goal_y), (PITCH_W - GOAL_AREA_D, goal_y)],
    "Small rect. right main": [(PITCH_W - GOAL_AREA_D, goal_y), (PITCH_W - GOAL_AREA_D, PITCH_H - goal_y)],
    "Small rect. right bottom": [(PITCH_W, PITCH_H - goal_y), (PITCH_W - GOAL_AREA_D, PITCH_H - goal_y)],
    "Goal left crossbar": [(0, gy - GOAL_W / 2), (0, gy + GOAL_W / 2)],
    "Goal right crossbar": [(PITCH_W, gy - GOAL_W / 2), (PITCH_W, gy + GOAL_W / 2)],
    "Middle line": [(PITCH_W / 2, 0), (PITCH_W / 2, PITCH_H)],
}


def frame_correspondences(labels, frame):
    """GT (image_px, pitch_m) pairs for one frame."""
    pairs = []
    for ann in labels["annotations"]:
        if int(str(ann["image_id"])[-6:]) != frame:
            continue
        bi, bp = ann.get("bbox_image"), ann.get("bbox_pitch")
        if bi is None or bp is None:
            continue
        if ann["category_id"] == 4:
            img_pt = [bi["x_center"], bi["y_center"]]
        else:
            img_pt = [bi["x_center"], bi["y"] + bi["h"]]
        # bbox_pitch is centered: x in [-52.5, 52.5], y in [-34, 34] -> shift to 0-105 / 0-68
        pairs.append((img_pt, [bp["x_bottom_middle"] + PITCH_W / 2, bp["y_bottom_middle"] + PITCH_H / 2]))
    return pairs


def fit_homography(pairs):
    src = np.float32([p[0] for p in pairs])
    dst = np.float32([p[1] for p in pairs])
    H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None or inliers is None or int(inliers.sum()) < 4:
        return None
    return H


def lines_in_image(H_inv, img_w, img_h):
    """Project template lines to normalized image-space segments.

    Endpoints may project far outside the frame — that's fine, intersections use the
    infinite line. Only degenerate (near-zero length) projections are dropped.
    """
    lines = {}
    for name, seg in TEMPLATE_LINES.items():
        pts = to_pitch(H_inv, seg, limit=1e7)
        if any(p is None for p in pts):
            continue
        (x1, y1), (x2, y2) = pts
        if abs(x1 - x2) + abs(y1 - y2) < 1e-6:
            continue
        lines[name] = ((x1 / img_w, y1 / img_h), (x2 / img_w, y2 / img_h))
    return lines


def main():
    random.seed(SEED)
    clips = sorted(p.name for p in GS.iterdir() if (p / "img1").is_dir())
    random.shuffle(clips)
    n_valid = max(1, int(len(clips) * CLIP_VALID_FRACTION))
    valid_clips = set(clips[:n_valid])

    for split in ["train", "valid"]:
        (OUT / split / "images").mkdir(parents=True, exist_ok=True)
        (OUT / split / "labels").mkdir(parents=True, exist_ok=True)

    n_kept = n_skip_res = n_skip_kpt = 0
    for clip in sorted(clips):
        split = "valid" if clip in valid_clips else "train"
        labels = json.load(open(GS / clip / "Labels-GameState.json"))
        img_w = int(labels["images"][0]["width"])
        img_h = int(labels["images"][0]["height"])
        for img_info in labels["images"][::FRAME_STRIDE]:
            frame = int(img_info["file_name"].split(".")[0])
            pairs = frame_correspondences(labels, frame)
            if len(pairs) < MIN_CORRESPONDENCES:
                n_skip_res += 1
                continue
            H = fit_homography(pairs)
            if H is None:
                n_skip_res += 1
                continue
            lines = lines_in_image(np.linalg.inv(H), img_w, img_h)
            kpts = build_keypoints(lines)
            if sum(1 for _, _, v in kpts if v) < MIN_VISIBLE_KPTS:
                n_skip_kpt += 1
                continue
            src_img = GS / clip / "img1" / f"{frame:06d}.jpg"
            if not src_img.exists():
                continue
            dst_name = f"{clip}_{frame:06d}.jpg"
            shutil.copy(src_img, OUT / split / "images" / dst_name)
            kpt_str = " ".join(f"{x:.6f} {y:.6f} {v}" for x, y, v in kpts)
            with open(OUT / split / "labels" / (dst_name.replace(".jpg", ".txt")), "w") as f:
                f.write(f"0 0.5 0.5 1.0 1.0 {kpt_str}\n")
            n_kept += 1
        print(f"{clip} -> {split} done", flush=True)

    shutil.copy(Path(__file__).parent / "dataset" / "data.yaml", OUT / "data.yaml")
    print(f"kept {n_kept} | skipped (correspondences/homography): {n_skip_res} | skipped (kpts): {n_skip_kpt}")
    print(f"valid clips: {sorted(valid_clips)}")


if __name__ == "__main__":
    main()
