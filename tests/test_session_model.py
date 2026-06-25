from __future__ import annotations

import asyncio

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
