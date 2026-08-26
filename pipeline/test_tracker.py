"""Simulate video tracking over consecutive frames of one sequence to test the ball filter."""
import glob
from collections import defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))

from inference import process_frame_tracked

frames = sorted(glob.glob("players/dataset_stride2/train/images/SNMOT-060_*.jpg"))[:120]
print(f"testing on {len(frames)} consecutive-ish frames of SNMOT-060")

detected = coasted = lost = 0
for f in frames:
    r = process_frame_tracked(f)
    t = r["ball_tracked"]
    if t is None:
        lost += 1
    elif t["coasting"]:
        coasted += 1
    else:
        detected += 1

n = len(frames)
print(f"raw detection would show ball in {detected}/{n} frames ({detected / n:.0%})")
print(f"with tracker: ball position available in {detected + coasted}/{n} frames ({(detected + coasted) / n:.0%})")
print(f"  detected: {detected}  coasted-through: {coasted}  lost: {lost}")
