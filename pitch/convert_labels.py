"""Convert SoccerNet calibration-2023 line annotations to YOLO-pose keypoint labels.

The calibration JSONs contain named pitch line segments in normalized image coords.
Keypoints are derived as line-line intersections (extended where needed). One pose
object per image: full-frame bbox + 26 keypoints with visibility flags.

Keypoint order:
  0-9   left side: pitch corners, penalty-area outer/inner corners, goal-area outer/inner corners
  10-19 right side: same
  20-23 goal crossbar ends (left goal l/r, right goal l/r)
  24-25 halfway line ends (top, bottom)
"""
import json
import shutil
from pathlib import Path

RAW = Path(__file__).parent / "raw_data" / "calibration-2023"
OUT = Path(__file__).parent / "dataset"
NUM_KPTS = 26
MARGIN = 0.02


def line_through(pts):
    if not pts:
        return None
    (x1, y1), (x2, y2) = (pts[0]["x"], pts[0]["y"]), (pts[-1]["x"], pts[-1]["y"])
    return (x1, y1), (x2, y2)


def intersect(l1, l2):
    (x1, y1), (x2, y2) = l1
    (x3, y3), (x4, y4) = l2
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


def kpt_from_intersection(lines, name_a, name_b):
    la, lb = lines.get(name_a), lines.get(name_b)
    if la is None or lb is None:
        return (0.0, 0.0, 0)
    p = intersect(la, lb)
    if p is None:
        return (0.0, 0.0, 0)
    x, y = p
    if -MARGIN <= x <= 1 + MARGIN and -MARGIN <= y <= 1 + MARGIN:
        return (min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0), 2)
    return (0.0, 0.0, 0)


def kpt_from_endpoint(lines, name, idx):
    l = lines.get(name)
    if l is None:
        return (0.0, 0.0, 0)
    x, y = l[idx]
    if -MARGIN <= x <= 1 + MARGIN and -MARGIN <= y <= 1 + MARGIN:
        return (min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0), 2)
    return (0.0, 0.0, 0)


def build_keypoints(lines):
    kpts = []
    for side in ["left", "right"]:
        kpts.append(kpt_from_intersection(lines, "Side line top", f"Side line {side}"))
        kpts.append(kpt_from_intersection(lines, "Side line bottom", f"Side line {side}"))
        kpts.append(kpt_from_intersection(lines, f"Side line {side}", f"Big rect. {side} top"))
        kpts.append(kpt_from_intersection(lines, f"Side line {side}", f"Big rect. {side} bottom"))
        kpts.append(kpt_from_intersection(lines, f"Big rect. {side} main", f"Big rect. {side} top"))
        kpts.append(kpt_from_intersection(lines, f"Big rect. {side} main", f"Big rect. {side} bottom"))
        kpts.append(kpt_from_intersection(lines, f"Side line {side}", f"Small rect. {side} top"))
        kpts.append(kpt_from_intersection(lines, f"Side line {side}", f"Small rect. {side} bottom"))
        kpts.append(kpt_from_intersection(lines, f"Small rect. {side} main", f"Small rect. {side} top"))
        kpts.append(kpt_from_intersection(lines, f"Small rect. {side} main", f"Small rect. {side} bottom"))
    kpts.append(kpt_from_endpoint(lines, "Goal left crossbar", 0))
    kpts.append(kpt_from_endpoint(lines, "Goal left crossbar", 1))
    kpts.append(kpt_from_endpoint(lines, "Goal right crossbar", 0))
    kpts.append(kpt_from_endpoint(lines, "Goal right crossbar", 1))
    kpts.append(kpt_from_intersection(lines, "Middle line", "Side line top"))
    kpts.append(kpt_from_intersection(lines, "Middle line", "Side line bottom"))
    assert len(kpts) == NUM_KPTS
    return kpts


def convert_split(split):
    src = RAW / split
    images_out = OUT / split / "images"
    labels_out = OUT / split / "labels"
    images_out.mkdir(parents=True, exist_ok=True)
    labels_out.mkdir(parents=True, exist_ok=True)

    n_kept = 0
    n_skipped = 0
    for json_path in sorted(src.glob("*.json")):
        img_path = src / (json_path.stem + ".jpg")
        if not img_path.exists():
            continue
        lines = {}
        for name, pts in json.loads(json_path.read_text()).items():
            l = line_through(pts)
            if l is not None:
                lines[name.strip()] = l
        kpts = build_keypoints(lines)
        if all(v == 0 for _, _, v in kpts):
            n_skipped += 1
            continue
        kpt_str = " ".join(f"{x:.6f} {y:.6f} {v}" for x, y, v in kpts)
        with open(labels_out / (json_path.stem + ".txt"), "w") as f:
            f.write(f"0 0.5 0.5 1.0 1.0 {kpt_str}\n")
        shutil.copy(img_path, images_out / img_path.name)
        n_kept += 1

    print(f"{split}: kept {n_kept}, skipped {n_skipped} (no visible keypoints)")


def main():
    for split in ["train", "valid"]:
        convert_split(split)


if __name__ == "__main__":
    main()
