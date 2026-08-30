"""S3 bucket utilities for the soccer pipeline.

Downloads files from a Railway bucket (S3-compatible) to a local cache directory
on first access, then serves them from the local cache on subsequent calls.
"""
import os
import threading
from pathlib import Path

import boto3
from botocore.config import Config

_local_lock = threading.Lock()
_downloaded = set()


def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL"),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        config=Config(signature_version="s3v4"),
        region_name=os.environ.get("AWS_DEFAULT_REGION"),
    )


def _bucket():
    return os.environ.get("AWS_S3_BUCKET_NAME")


def _local_root():
    root = Path(os.environ.get("LOCAL_DATA_DIR", "/tmp/soccer_data"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def get_path(key: str) -> Path:
    """Resolve a bucket key to a local file path, downloading if necessary."""
    local = _local_root() / key
    local.parent.mkdir(parents=True, exist_ok=True)
    if local.exists() and local.stat().st_size > 0:
        return local
    with _local_lock:
        if key in _downloaded:
            return local
        client = _client()
        try:
            client.download_file(_bucket(), key, str(local))
            _downloaded.add(key)
        except Exception as e:
            raise FileNotFoundError(f"bucket key not found: {key} ({e})") from e
    return local


def get_bytes(key: str) -> bytes:
    """Download a small file as bytes (for video frames, etc.)."""
    client = _client()
    obj = client.get_object(Bucket=_bucket(), Key=key)
    return obj["Body"].read()


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream"):
    """Upload bytes to a key. Used for caching derived artifacts (MP4
    videos of clips, precomputed analysis) so the next request is a single
    GET instead of a full rebuild."""
    client = _client()
    client.put_object(Bucket=_bucket(), Key=key, Body=data, ContentType=content_type)


def list_keys(prefix: str = "") -> list:
    """List all keys in the bucket with the given prefix."""
    client = _client()
    keys = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return keys
