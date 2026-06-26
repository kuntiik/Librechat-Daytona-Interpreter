from __future__ import annotations

import time
from typing import Callable
from uuid import uuid4

from .errors import APIError
from .session_store import SessionRecord, SessionStore


def _normalized_language(language: str) -> str:
    """Collapse languages that share one underlying sandbox.

    `Gateway.create_sandbox` coerces bash -> python (the bash bridge runs
    inside the python sandbox), so a `python` upload session and a `bash`
    exec request live in the *same* sandbox. Comparing raw languages would
    wrongly reject reuse with a 409, orphaning uploaded files.
    """
    return "python" if language == "bash" else language


class SessionService:
    def __init__(
        self,
        store: SessionStore,
        gateway: object,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._gateway = gateway
        self._clock = clock

    def _now(self) -> float:
        return self._clock()

    @staticmethod
    def _enforce_owner(record: SessionRecord, owner: str | None) -> None:
        if record.owner and owner and record.owner != owner:
            raise APIError(
                status_code=403,
                code="forbidden",
                message="Session does not belong to this principal.",
            )

    async def get_or_create_exec_session(
        self,
        session_id: str | None,
        language: str,
        owner: str | None = None,
    ) -> SessionRecord:
        if session_id:
            existing = await self._store.get(session_id)
            if existing is not None:
                self._enforce_owner(existing, owner)
                if _normalized_language(existing.language) != _normalized_language(language):
                    raise APIError(
                        status_code=409,
                        code="session_language_mismatch",
                        message=(
                            f"Session '{session_id}' already uses language '{existing.language}', "
                            f"but request asked for '{language}'."
                        ),
                    )
                await self.touch(session_id)
                return existing
            return await self._create_session(session_id, language, owner=owner)

        generated_session_id = str(uuid4())
        return await self._create_session(generated_session_id, language, owner=owner)

    async def get_or_create_upload_session(
        self,
        session_id: str | None,
        default_language: str = "python",
        owner: str | None = None,
    ) -> SessionRecord:
        if session_id:
            existing = await self._store.get(session_id)
            if existing is not None:
                self._enforce_owner(existing, owner)
                await self.touch(session_id)
                return existing
            return await self._create_session(session_id, default_language, owner=owner)

        generated_session_id = str(uuid4())
        return await self._create_session(generated_session_id, default_language, owner=owner)

    async def require_session(self, session_id: str, owner: str | None = None) -> SessionRecord:
        existing = await self._store.get(session_id)
        if existing is None:
            raise APIError(
                status_code=404,
                code="session_not_found",
                message=f"Session '{session_id}' does not exist.",
            )
        self._enforce_owner(existing, owner)
        await self.touch(session_id)
        return existing

    async def touch(self, session_id: str) -> None:
        await self._store.touch(session_id, self._now())

    async def delete_session(self, session_id: str) -> None:
        await self._store.delete(session_id)

    async def _create_session(
        self,
        session_id: str,
        language: str,
        owner: str | None = None,
    ) -> SessionRecord:
        sandbox_id = self._gateway.create_sandbox(language)
        record = SessionRecord(
            session_id=session_id,
            sandbox_id=sandbox_id,
            language=language,
            last_access=self._now(),
            owner=owner,
        )
        await self._store.upsert(record)
        return record

