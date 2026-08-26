"""Convert SoccerNet tracking MOT annotations to YOLO format for ball detection."""
import configparser
import random
import shutil
from pathlib import Path

RAW = Path(__file__).parent / "raw_data" / "tracking" / "train"
OUT = Path(__file__).parent / "dataset"
VALID_FRACTION = 0.2
SEED = 42


def find_ball_tracklet_id(gameinfo_path):
    cfg = configparser.ConfigParser()
    cfg.read(gameinfo_path)
    for key, value in cfg["Sequence"].items():
        if key.startswith("trackletid_") and value.strip().lower().startswith("ball"):
            return int(key.split("_")[1])
    return None


def read_seq_size(seqinfo_path):
    cfg = configparser.ConfigParser()
    cfg.read(seqinfo_path)
    w = int(cfg["Sequence"]["imWidth"])
    h = int(cfg["Sequence"]["imHeight"])
    return w, h


def convert_sequence(seq_dir, images_out, labels_out):
    ball_id = find_ball_tracklet_id(seq_dir / "gameinfo.ini")
    if ball_id is None:
        return 0
    img_w, img_h = read_seq_size(seq_dir / "seqinfo.ini")

    frames = {}
    with open(seq_dir / "gt" / "gt.txt") as f:
        for line in f:
            parts = line.strip().split(",")
            frame, track_id = int(parts[0]), int(parts[1])
            if track_id != ball_id:
                continue
            left, top, w, h = map(float, parts[2:6])
            cx = (left + w / 2) / img_w
            cy = (top + h / 2) / img_h
            nw = w / img_w
            nh = h / img_h
            frames[frame] = (cx, cy, nw, nh)

    count = 0
    for frame, (cx, cy, nw, nh) in frames.items():
        img_name = f"{frame:06d}.jpg"
        src_img = seq_dir / "img1" / img_name
        if not src_img.exists():
            continue
        dst_name = f"{seq_dir.name}_{img_name}"
        shutil.copy(src_img, images_out / dst_name)
        with open(labels_out / dst_name.replace(".jpg", ".txt"), "w") as lf:
            lf.write(f"0 {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n")
        count += 1
    return count


def main():
    for split in ["train", "valid"]:
        (OUT / split / "images").mkdir(parents=True, exist_ok=True)
        (OUT / split / "labels").mkdir(parents=True, exist_ok=True)

    seqs = sorted(p for p in RAW.iterdir() if p.is_dir())
    random.Random(SEED).shuffle(seqs)
    n_valid = max(1, int(len(seqs) * VALID_FRACTION))
    valid_seqs = set(s.name for s in seqs[:n_valid])

    total = 0
    for seq_dir in sorted(RAW.iterdir()):
        if not seq_dir.is_dir():
            continue
        split = "valid" if seq_dir.name in valid_seqs else "train"
        n = convert_sequence(seq_dir, OUT / split / "images", OUT / split / "labels")
        print(f"{seq_dir.name} -> {split}: {n} labeled frames")
        total += n

    print(f"Total labeled frames: {total}")
    print(f"Valid sequences: {sorted(valid_seqs)}")


if __name__ == "__main__":
    main()
