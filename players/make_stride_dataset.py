"""Subsample the player dataset via temporal stride: keep every Nth frame per sequence.

Adjacent SoccerNet frames (2 fps) are near-duplicates, so striding removes redundancy
more predictably than random sampling.
"""
import shutil
from collections import defaultdict
from pathlib import Path

SRC = Path(__file__).parent / "dataset"
DST = Path(__file__).parent / "dataset_stride2"
STRIDE = 2


def parse_name(img_path):
    seq, frame = img_path.stem.split("_", 1)
    return seq, int(frame)


def main():
    for split in ["train", "valid"]:
        src_images = SRC / split / "images"
        src_labels = SRC / split / "labels"
        dst_images = DST / split / "images"
        dst_labels = DST / split / "labels"
        dst_images.mkdir(parents=True, exist_ok=True)
        dst_labels.mkdir(parents=True, exist_ok=True)

        by_seq = defaultdict(list)
        for img_path in sorted(src_images.glob("*.jpg")):
            seq, frame = parse_name(img_path)
            by_seq[seq].append((frame, img_path))

        kept = 0
        total = 0
        for seq, frames in sorted(by_seq.items()):
            frames.sort()
            total += len(frames)
            for i, (frame, img_path) in enumerate(frames):
                if i % STRIDE != 0:
                    continue
                label_path = src_labels / (img_path.stem + ".txt")
                if not label_path.exists():
                    continue
                shutil.copy(img_path, dst_images / img_path.name)
                shutil.copy(label_path, dst_labels / label_path.name)
                kept += 1

        print(f"{split}: kept {kept} / {total} frames (stride {STRIDE})")

    shutil.copy(SRC / "data.yaml", DST / "data.yaml")
    print("wrote", DST / "data.yaml")


if __name__ == "__main__":
    main()

