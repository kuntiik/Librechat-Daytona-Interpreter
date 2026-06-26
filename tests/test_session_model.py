from __future__ import annotations

import asyncio

import pytest

from app.errors import APIError
from app.session_service import SessionService
from app.session_store import MemorySessionStore

from tests.test_api import FakeDaytonaGateway


def _make_service() -> tuple[SessionService, FakeDaytonaGateway]:
    gateway = FakeDaytonaGateway()
    service = SessionService(store=MemorySessionStore(), gateway=gateway)
    return service, gateway


def test_mint_on_none_generates_session_id() -> None:
    service, gateway = _make_service()

    record = asyncio.run(service.get_or_create_exec_session(None, "python"))

    assert isinstance(record.session_id, str)
    assert len(record.session_id) > 0
    assert record.session_id != "None"
    assert gateway._counter == 1


def test_reuse_same_session_id_reuses_sandbox() -> None:
    service, gateway = _make_service()
    sid = "vendor-session-xyz"

    first = asyncio.run(service.get_or_create_exec_session(sid, "python"))
    second = asyncio.run(service.get_or_create_exec_session(sid, "python"))

    assert first.sandbox_id == second.sandbox_id
    assert gateway._counter == 1


def test_distinct_session_ids_get_isolated_sandboxes() -> None:
    service, gateway = _make_service()

    first = asyncio.run(service.get_or_create_exec_session(None, "python"))
    second = asyncio.run(service.get_or_create_exec_session(None, "python"))

    assert first.session_id != second.session_id
    assert first.sandbox_id != second.sandbox_id
    assert gateway._counter == 2


def test_same_owner_reuses_sandbox() -> None:
    service, gateway = _make_service()
    sid = "vendor-session-owned"

    first = asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))
    second = asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))

    assert first.sandbox_id == second.sandbox_id
    assert gateway._counter == 1


def test_cross_principal_reuse_is_rejected() -> None:
    service, _ = _make_service()
    sid = "vendor-session-owned"

    asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))

    with pytest.raises(APIError) as excinfo:
        asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userB"))
    assert excinfo.value.status_code == 403


def test_owner_none_is_permissive_against_owned_session() -> None:
    service, gateway = _make_service()
    sid = "vendor-session-owned"

    asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))
    record = asyncio.run(service.get_or_create_exec_session(sid, "python", owner=None))

    assert record.owner == "userA"
    assert gateway._counter == 1


def test_ownerless_session_accepts_named_owner() -> None:
    service, gateway = _make_service()
    sid = "legacy-session"

    asyncio.run(service.get_or_create_exec_session(sid, "python", owner=None))
    record = asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))

    assert record.owner is None
    assert gateway._counter == 1


def test_upload_cross_principal_reuse_is_rejected() -> None:
    service, _ = _make_service()
    sid = "vendor-upload-owned"

    asyncio.run(service.get_or_create_upload_session(sid, owner="userA"))

    with pytest.raises(APIError) as excinfo:
        asyncio.run(service.get_or_create_upload_session(sid, owner="userB"))
    assert excinfo.value.status_code == 403


def test_require_session_owner_none_is_permissive() -> None:
    service, _ = _make_service()
    sid = "vendor-session-owned"

    asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))
    record = asyncio.run(service.require_session(sid, owner=None))

    assert record.owner == "userA"


def test_require_session_rejects_cross_principal() -> None:
    service, _ = _make_service()
    sid = "vendor-session-owned"

    asyncio.run(service.get_or_create_exec_session(sid, "python", owner="userA"))

    with pytest.raises(APIError) as excinfo:
        asyncio.run(service.require_session(sid, owner="userB"))
    assert excinfo.value.status_code == 403
