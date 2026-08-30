"""One-time upload of pitch/raw_data/gamestate-2024 to the Railway S3-compatible bucket.

Reads credentials from env vars (same names Railway injects into a linked service):
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL,
  AWS_DEFAULT_REGION, AWS_S3_BUCKET_NAME

Resumable: skips objects that already exist in the bucket with a matching size,
so a dropped connection just needs a re-run.

Run:  python scripts/upload_dataset.py
"""
import os
import sys
import time
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

ROOT = Path(__file__).parent.parent
LOCAL_DIR = ROOT / "pitch" / "raw_data" / "gamestate-2024"
PREFIX = "gamestate-2024"
MAX_ATTEMPTS = 5


def upload_with_retry(s3, path, bucket, key, transfer_config):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            s3.upload_file(str(path), bucket, key, Config=transfer_config)
            return True
        except Exception as e:  # noqa: BLE001 - network errors vary by backend
            wait = min(30, 2 ** attempt)
            print(f"  retry {attempt}/{MAX_ATTEMPTS} for {key} after error: {e} (waiting {wait}s)")
            time.sleep(wait)
    return False


def main():
    bucket = os.environ.get("AWS_S3_BUCKET_NAME")
    if not bucket:
        sys.exit("AWS_S3_BUCKET_NAME not set — export the Railway bucket vars first")
    if not LOCAL_DIR.is_dir():
        sys.exit(f"local dataset not found: {LOCAL_DIR}")

    s3 = boto3.client("s3", config=Config(retries={"max_attempts": 10, "mode": "adaptive"}))
    # smaller multipart chunks + fewer concurrent parts: a dropped connection
    # loses less progress and reconnects faster than the 8MB/10-thread default
    transfer_config = TransferConfig(multipart_chunksize=64 * 1024 * 1024, max_concurrency=4)

    existing = {}
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=PREFIX + "/"):
        for obj in page.get("Contents", []):
            existing[obj["Key"]] = obj["Size"]

    files = [p for p in LOCAL_DIR.rglob("*") if p.is_file() and p.name != "valid.zip"]
    total = len(files)
    uploaded = 0
    skipped = 0
    failed = []

    for i, path in enumerate(files, 1):
        rel = path.relative_to(LOCAL_DIR).as_posix()
        key = f"{PREFIX}/{rel}"
        size = path.stat().st_size
        if existing.get(key) == size:
            skipped += 1
            continue
        if upload_with_retry(s3, path, bucket, key, transfer_config):
            uploaded += 1
        else:
            failed.append(key)
            print(f"  giving up on {key} after {MAX_ATTEMPTS} attempts")
        if i % 50 == 0 or i == total:
            print(f"{i}/{total} (uploaded {uploaded}, skipped {skipped}, failed {len(failed)})")

    print(f"done: uploaded {uploaded}, skipped {skipped}, failed {len(failed)}, total {total}")
    if failed:
        print("failed keys (re-run the script to retry these):")
        for k in failed:
            print(f"  {k}")


if __name__ == "__main__":
    main()
