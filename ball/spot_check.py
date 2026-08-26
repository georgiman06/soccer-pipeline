"""Draw converted YOLO boxes back on a few sample images to verify correctness."""
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
        for line in f:
            cls, cx, cy, bw, bh = map(float, line.split())
            x1 = int((cx - bw / 2) * w)
            y1 = int((cy - bh / 2) * h)
            x2 = int((cx + bw / 2) * w)
            y2 = int((cy + bh / 2) * h)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 2)
    out_path = OUT / img_path.name
    cv2.imwrite(str(out_path), img)
    print(f"wrote {out_path}")
