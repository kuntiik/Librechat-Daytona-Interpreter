from __future__ import annotations

import re
from pathlib import Path

from .file_ids import sanitize_upload_filename

# Identity-keyed persistent file storage. A bucket is a directory on the
# adapter host (`BUCKET_ROOT/<safe bucket key>/<safe filename>`) that holds the
# files belonging to one resource identity (an agent, a user, or a skill
# version). Buckets outlive ephemeral per-conversation sandboxes: on a
# sandbox's first exec the referenced bucket files are copied in, so reaping a
# sandbox never loses the source files.

_UNSAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


def bucket_key(kind: str, identity_id: str, version: int | str | None = None) -> str:
    """Logical bucket key mirroring LibreChat's sessionKey shape.

    `<kind>:<id>` for `agent`/`user`; `<kind>:<id>:v:<version>` for `skill`.
    This key round-trips: `/upload` returns it as `storage_session_id`, and the
    `/exec` file refs send it back so copy-in can locate the bucket.
    """
    key = f"{kind}:{identity_id}"
    if kind == "skill" and version is not None and str(version).strip():
        key = f"{key}:v:{version}"
    return key


def _safe_segment(value: str) -> str:
    cleaned = _UNSAFE_SEGMENT.sub("_", value).strip("._")
    if not cleaned or cleaned in {".", ".."}:
        raise ValueError(f"Unsafe bucket key: {value!r}")
    return cleaned


class BucketStore:
    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).expanduser().resolve()

    @property
    def root(self) -> Path:
        return self._root

    def _bucket_dir(self, key: str) -> Path:
        return self._root / _safe_segment(key)

    def write(self, key: str, filename: str, data: bytes) -> Path:
        safe_name = sanitize_upload_filename(filename)
        bucket_dir = self._bucket_dir(key)
        bucket_dir.mkdir(parents=True, exist_ok=True)
        destination = bucket_dir / safe_name
        destination.write_bytes(data)
        return destination

    def path(self, key: str, filename: str) -> Path | None:
        safe_name = sanitize_upload_filename(filename)
        candidate = self._bucket_dir(key) / safe_name
        return candidate if candidate.is_file() else None

    def exists(self, key: str, filename: str) -> bool:
        return self.path(key, filename) is not None

    def read(self, key: str, filename: str) -> bytes:
        candidate = self.path(key, filename)
        if candidate is None:
            raise FileNotFoundError(f"No file '{filename}' in bucket '{key}'.")
        return candidate.read_bytes()
