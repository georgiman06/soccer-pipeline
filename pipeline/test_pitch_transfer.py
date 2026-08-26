"""Measure pitch model transfer to tracking clips: kpt visibility + homography sanity vs GT."""
import glob
import random
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from ultralytics import YOLO
from pitch_map import homography_from_keypoints, to_pitch

m = YOLO("models/pitch_best.pt")
random.seed(0)

seqs = sorted(glob.glob("ball/raw_data/tracking/train/SNMOT-*"))
results = []
for seq_dir in random.sample(seqs, 12):
    frames = sorted(glob.glob(str(Path(seq_dir) / "img1" / "*.jpg")))
    for f in random.sample(frames, 3):
        r = m.predict(f, conf=0.05, verbose=False)[0]
        k = r.keypoints
        if k is None:
            results.append((Path(f).parent.parent.name, Path(f).stem, 0, 0, None))
            continue
        data = k.data[0]
        vis05 = (data[:, 2] > 0.5).sum()
        vis02 = (data[:, 2] > 0.2).sum()
        H = homography_from_keypoints(k.xy[0].tolist(), (data[:, 2] > 0.2).tolist())
        results.append((Path(f).parent.parent.name, Path(f).stem, int(vis05), int(vis02), H is not None))

print(f"{'seq':10} {'frame':8} {'kpt>0.5':>8} {'kpt>0.2':>8} {'H?':>3}")
for s, f, a, b, h in results:
    print(f"{s:10} {f:8} {a:8} {b:8} {str(h):>5}")
n_h = sum(1 for r in results if r[4])
print(f"\nframes with enough kpts for homography (>0.2 thresh): {n_h}/{len(results)}")

