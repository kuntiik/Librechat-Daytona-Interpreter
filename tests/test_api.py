from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from fastapi.testclient import TestClient

os.environ.setdefault("ADAPTER_API_KEY", "import-time-api-key")
os.environ.setdefault("DAYTONA_API_KEY", "import-time-daytona-key")

from app.config import Settings
from app.main import create_app
from app.session_store import MemorySessionStore


@dataclass
class FakeSandbox:
    language: str
    files: dict[str, bytes]


class FakeDaytonaGateway:
    def __init__(self) -> None:
        self._sandboxes: dict[str, FakeSandbox] = {}
        self._counter = 0
        self.upload_calls: list[tuple[str, str]] = []

    def create_sandbox(self, language: str) -> str:
        self._counter += 1
        sandbox_id = f"sandbox-{self._counter}"
        self._sandboxes[sandbox_id] = FakeSandbox(language=language, files={})
        return sandbox_id

    def delete_sandbox(self, sandbox_id: str) -> None:
        self._sandboxes.pop(sandbox_id, None)

    def run_code(self, sandbox_id: str, language: str, code: str) -> dict[str, Any]:
        sandbox = self._sandboxes[sandbox_id]
        return {
            "stdout": f"ran:{language}:{code}",
            "stderr": "",
            "code": 0,
            "status": "completed",
            "output": f"ran:{language}:{code}",
        }

    def upload_file(self, sandbox_id: str, destination_path: str, content: bytes) -> None:
        sandbox = self._sandboxes[sandbox_id]
        sandbox.files[destination_path] = content
        self.upload_calls.append((sandbox_id, destination_path))

    def list_files(self, sandbox_id: str, _: str = "/workspace") -> list[dict[str, Any]]:
        sandbox = self._sandboxes[sandbox_id]
        return [
            {
                "path": path,
                "name": PurePosixPath(path).name,
                "size": len(content),
            }
            for path, content in sorted(sandbox.files.items())
        ]

    def download_file(self, sandbox_id: str, path: str) -> bytes:
        sandbox = self._sandboxes[sandbox_id]
        return sandbox.files[path]

    def delete_file(self, sandbox_id: str, path: str) -> None:
        sandbox = self._sandboxes[sandbox_id]
        sandbox.files.pop(path, None)


def make_client(bucket_root: str | None = None) -> tuple[TestClient, FakeDaytonaGateway]:
    settings = Settings(
        ADAPTER_API_KEY="test-adapter-key",
        DAYTONA_API_KEY="test-daytona-key",
        SESSION_TTL_SECONDS=1800,
        CLEANUP_INTERVAL_SECONDS=60,
        BUCKET_ROOT=bucket_root or tempfile.mkdtemp(prefix="lc-buckets-"),
    )
    gateway = FakeDaytonaGateway()
    app = create_app(
        settings=settings,
        store=MemorySessionStore(),
        gateway=gateway,
        enable_cleanup=False,
    )
    return TestClient(app), gateway


def test_auth_required() -> None:
    client, _ = make_client()
    response = client.post("/exec", json={"code": "print(1)", "lang": "python"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_exec_creates_session() -> None:
    client, _ = make_client()
    response = client.post(
        "/exec",
        headers={"x-api-key": "test-adapter-key"},
        json={"code": "print(1)", "lang": "py"},
    )
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["session_id"], str)
    assert set(body["run"].keys()) == {"stdout", "stderr", "code", "status", "output"}
    assert isinstance(body["files"], list)


def test_upload_list_download_delete_flow() -> None:
    client, _ = make_client()
    headers = {"x-api-key": "test-adapter-key"}

    upload_response = client.post(
        "/upload",
        headers=headers,
        files=[("files", ("example.txt", b"hello daytona", "text/plain"))],
    )
    assert upload_response.status_code == 200
    upload_body = upload_response.json()
    session_id = upload_body["session_id"]
    assert upload_body["message"] == "success"
    assert upload_body["sessionId"] == session_id
    uploaded_file = upload_body["files"][0]
    file_id = uploaded_file["fileId"]
    assert uploaded_file["filename"] == "example.txt"
    assert uploaded_file["id"] == file_id
    assert uploaded_file["file_id"] == file_id
    assert set(uploaded_file.keys()) == {"fileId", "filename", "id", "file_id"}

    list_response = client.get(f"/files/{session_id}", headers=headers)
    assert list_response.status_code == 200
    list_body = list_response.json()
    assert list_body["session_id"] == session_id
    assert list_body["sessionId"] == session_id
    listed = list_body["files"]
    assert len(listed) == 1
    assert listed[0]["path"] == "/workspace/example.txt"
    assert listed[0]["fileId"] == file_id
    assert listed[0]["filename"] == "example.txt"
    assert isinstance(listed[0]["lastModified"], str)
    assert listed[0]["lastModified"].endswith("Z")

    download_response = client.get(f"/download/{session_id}/{file_id}", headers=headers)
    assert download_response.status_code == 200
    assert download_response.content == b"hello daytona"
    assert "attachment; filename=\"example.txt\"" in download_response.headers["content-disposition"]

    delete_response = client.delete(f"/files/{session_id}/{file_id}", headers=headers)
    assert delete_response.status_code == 200
    assert delete_response.json()["deleted"] is True

    list_after_delete = client.get(f"/files/{session_id}", headers=headers)
    assert list_after_delete.status_code == 200
    assert list_after_delete.json()["files"] == []


def test_upload_rejects_oversized_file() -> None:
    client, _ = make_client()
    headers = {"x-api-key": "test-adapter-key"}
    oversized_payload = b"x" * (20 * 1024 * 1024 + 1)

    response = client.post(
        "/upload",
        headers=headers,
        files=[("files", ("large.bin", oversized_payload, "application/octet-stream"))],
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


def test_session_language_mismatch_returns_409() -> None:
    client, _ = make_client()
    headers = {"x-api-key": "test-adapter-key"}

    first_response = client.post(
        "/exec",
        headers=headers,
        json={"code": "print(1)", "lang": "python"},
    )
    assert first_response.status_code == 200
    session_id = first_response.json()["session_id"]

    second_response = client.post(
        "/exec",
        headers=headers,
        json={"code": "console.log(1)", "lang": "javascript", "session_id": session_id},
    )
    assert second_response.status_code == 409
    assert second_response.json()["error"]["code"] == "session_language_mismatch"


def _upload_to_bucket(client: TestClient, kind: str, identity_id: str, name: str, data: bytes) -> dict[str, Any]:
    response = client.post(
        "/upload",
        headers={"x-api-key": "test-adapter-key"},
        data={"kind": kind, "id": identity_id},
        files=[("files", (name, data, "application/octet-stream"))],
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_identity_upload_writes_to_bucket_without_sandbox() -> None:
    client, gateway = make_client()
    body = _upload_to_bucket(client, "agent", "agent-123", "template.xlsx", b"xlsx-bytes")

    assert body["storage_session_id"] == "agent:agent-123"
    assert body["session_id"] == "agent:agent-123"
    assert body["files"][0]["filename"] == "template.xlsx"
    # The whole point of the split: an identity upload creates NO sandbox.
    assert gateway._counter == 0
    assert gateway._sandboxes == {}


def test_skill_upload_bucket_key_includes_version() -> None:
    client, _ = make_client()
    response = client.post(
        "/upload",
        headers={"x-api-key": "test-adapter-key"},
        data={"kind": "skill", "id": "pptx", "version": "3"},
        files=[("files", ("editing.md", b"# skill", "text/markdown"))],
    )
    assert response.status_code == 200, response.text
    assert response.json()["storage_session_id"] == "skill:pptx:v:3"


def test_object_info_returns_lastmodified_for_bucket_file() -> None:
    client, gateway = make_client()
    body = _upload_to_bucket(client, "user", "u-1", "data.xlsx", b"xlsx-bytes")
    key = body["storage_session_id"]
    file_id = body["files"][0]["file_id"]

    response = client.get(
        f"/sessions/{key}/objects/{file_id}",
        headers={"x-api-key": "test-adapter-key"},
        params={"kind": "user", "id": "u-1"},
    )
    assert response.status_code == 200, response.text
    info = response.json()
    assert info["name"] == "data.xlsx"
    assert info["size"] == len(b"xlsx-bytes")
    assert info["lastModified"]
    # Probing a bucket file must not spin up a sandbox.
    assert gateway._counter == 0


def test_object_info_404_for_missing_object() -> None:
    client, _ = make_client()
    _upload_to_bucket(client, "user", "u-2", "present.xlsx", b"data")

    response = client.get(
        "/sessions/user:u-2/objects/absent.xlsx",
        headers={"x-api-key": "test-adapter-key"},
        params={"kind": "user", "id": "u-2"},
    )
    assert response.status_code == 404


def test_exec_copies_bucket_files_into_conversation_sandbox() -> None:
    client, gateway = make_client()
    _upload_to_bucket(client, "agent", "promo", "_TEMPLATE_promo_dohoda.xlsx", b"template")
    _upload_to_bucket(client, "agent", "promo", "product-master.xlsx", b"master")

    headers = {"x-api-key": "test-adapter-key"}
    refs = [
        {"storage_session_id": "agent:promo", "name": "_TEMPLATE_promo_dohoda.xlsx"},
        {"storage_session_id": "agent:promo", "name": "product-master.xlsx"},
    ]
    response = client.post(
        "/exec",
        headers=headers,
        json={"code": "print('build')", "lang": "python", "session_id": "conv-1", "files": refs},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["session_id"] == "conv-1"
    listed = sorted(f["filename"] for f in body["files"])
    assert listed == ["_TEMPLATE_promo_dohoda.xlsx", "product-master.xlsx"]
    # One sandbox keyed by the conversation, both bucket files copied in.
    assert gateway._counter == 1


def test_exec_copy_in_is_idempotent_across_turns() -> None:
    client, gateway = make_client()
    _upload_to_bucket(client, "agent", "promo", "data.csv", b"col\n1\n")
    headers = {"x-api-key": "test-adapter-key"}
    refs = [{"storage_session_id": "agent:promo", "name": "data.csv"}]

    first = client.post(
        "/exec",
        headers=headers,
        json={"code": "print(1)", "lang": "python", "session_id": "conv-2", "files": refs},
    )
    assert first.status_code == 200
    second = client.post(
        "/exec",
        headers=headers,
        json={"code": "print(2)", "lang": "python", "session_id": "conv-2", "files": refs},
    )
    assert second.status_code == 200
    # Copied once on turn 1; turn 2 sees it already present and skips the copy.
    copy_ins = [path for _, path in gateway.upload_calls if path.endswith("data.csv")]
    assert len(copy_ins) == 1


def test_two_conversations_get_isolated_sandboxes() -> None:
    client, gateway = make_client()
    _upload_to_bucket(client, "agent", "shared", "data.csv", b"x")
    headers = {"x-api-key": "test-adapter-key"}
    refs = [{"storage_session_id": "agent:shared", "name": "data.csv"}]

    for conversation_id in ("conv-A", "conv-B"):
        response = client.post(
            "/exec",
            headers=headers,
            json={"code": "print(1)", "lang": "python", "session_id": conversation_id, "files": refs},
        )
        assert response.status_code == 200
        assert [f["filename"] for f in response.json()["files"]] == ["data.csv"]

    # Two distinct sandboxes, each independently hydrated from the one bucket.
    assert gateway._counter == 2


def test_legacy_upload_without_identity_still_uses_sandbox() -> None:
    client, gateway = make_client()
    response = client.post(
        "/upload",
        headers={"x-api-key": "test-adapter-key"},
        files=[("files", ("legacy.txt", b"hi", "text/plain"))],
    )
    assert response.status_code == 200, response.text
    # No identity -> falls back to the sandbox-backed path (one sandbox created).
    assert gateway._counter == 1
    assert response.json()["files"][0]["filename"] == "legacy.txt"

