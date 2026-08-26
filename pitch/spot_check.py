"""Draw converted YOLO-pose keypoints back on sample images to verify correctness."""
import random
from pathlib import Path

import cv2

DATASET = Path(__file__).parent / "dataset"
OUT = Path(__file__).parent / "spot_check_out"
OUT.mkdir(exist_ok=True)

random.seed(1)
images = sorted((DATASET / "train" / "images").glob("*.jpg"))
sample = random.sample(images, 3)

for img_path in sample:
    label_path = DATASET / "train" / "labels" / (img_path.stem + ".txt")
    img = cv2.imread(str(img_path))
    h, w = img.shape[:2]
    with open(label_path) as f:
        parts = f.read().split()
    kpts = parts[5:]
    for i in range(0, len(kpts), 3):
        x, y, v = float(kpts[i]), float(kpts[i + 1]), int(kpts[i + 2])
        if v > 0:
            px, py = int(x * w), int(y * h)
            cv2.circle(img, (px, py), 5, (0, 0, 255), -1)
            cv2.putText(img, str(i // 3), (px + 6, py - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    out_path = OUT / img_path.name
    cv2.imwrite(str(out_path), img)
    print(f"wrote {out_path}")
