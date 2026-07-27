from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

os.environ.setdefault("ADAPTER_API_KEY", "import-time-api-key")
os.environ.setdefault("DAYTONA_API_KEY", "import-time-daytona-key")

from app.config import get_settings
from app.daytona_gateway import DaytonaGateway


def _wrapper_for(code: str) -> str:
    gateway = object.__new__(DaytonaGateway)
    captured: dict[str, str] = {}

    def capture(_sandbox: Any, wrapper: str) -> dict[str, Any]:
        captured["wrapper"] = wrapper
        return {}

    gateway._run_python_wrapper = capture  # type: ignore[method-assign]
    gateway._run_shell(object(), code)
    return captured["wrapper"]


def _workspace(tmp_path: Any) -> None:
    os.environ["WORKSPACE_ROOT"] = str(tmp_path / "workspace")
    get_settings.cache_clear()


def test_large_shell_snippet_is_not_passed_through_argv(tmp_path: Any) -> None:
    """A 2 MB shell step must still run.

    execve caps a single argument at MAX_ARG_STRLEN (128 KiB on Linux), so
    embedding the snippet in `bash -c <snippet>` fails with
    `OSError: [Errno 7] Argument list too long: '/bin/bash'` as soon as the
    agent inlines a sizable payload (a JSON blob from a previous tool call).
    """
    _workspace(tmp_path)
    payload = "x" * (2 * 1024 * 1024)
    target = tmp_path / "big.txt"
    code = f"cat <<'EOF' > {target}\n{payload}\nEOF\nwc -c < {target}"

    wrapper = _wrapper_for(code)
    result = subprocess.run(
        [sys.executable, "-"],
        input=wrapper,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(len(payload) + 1)


def test_shell_snippet_runs_in_the_workspace(tmp_path: Any) -> None:
    _workspace(tmp_path)

    wrapper = _wrapper_for("pwd && echo hello")
    result = subprocess.run(
        [sys.executable, "-"],
        input=wrapper,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [str(tmp_path / "workspace"), "hello"]


def test_failing_shell_snippet_propagates_exit_code(tmp_path: Any) -> None:
    _workspace(tmp_path)

    wrapper = _wrapper_for("echo boom >&2; exit 3")
    result = subprocess.run(
        [sys.executable, "-"],
        input=wrapper,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 3
    assert "boom" in result.stderr
