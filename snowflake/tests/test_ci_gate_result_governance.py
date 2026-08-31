"""Governance and behavioural tests for the aggregate CI result gate."""

from __future__ import annotations

import ast
import json
import runpy
import shutil
import stat
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import cast

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ci_gate_result as gate  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
if _REPO.name == "snowflake":
    _REPO = _REPO.parent
_SCRIPT = _REPO / "snowflake" / "ci_gate_result.py"
_FULL_ONLY = ("playwright", "snowflake-migrations", "mutation-testing")
_ALWAYS = ("gates", "classify")


def _needs_values(raw_job: dict[str, object]) -> set[str]:
    """Normalize one workflow job's needs declaration."""

    needs: object = raw_job.get("needs", [])
    if isinstance(needs, str):
        return {needs}
    assert isinstance(needs, list)
    values = {value for value in cast(list[object], needs) if isinstance(value, str)}
    assert len(values) == len(needs)
    return values


def test_workflow_consumes_classifier_for_exact_full_only_job_set() -> None:
    """TW1/TW2: only the expensive jobs consume full mode; gates stays always-on."""

    loaded: object = yaml.safe_load(
        (_REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    )
    assert isinstance(loaded, dict)
    jobs = cast(dict[str, dict[str, object]], loaded["jobs"])

    for job_id in _FULL_ONLY:
        job = jobs[job_id]
        assert "classify" in _needs_values(job)
        assert job["if"] == "${{ needs.classify.outputs.mode == 'full' }}"

    gates = jobs["gates"]
    assert "classify" not in _needs_values(gates)
    assert "needs.classify.outputs.mode" not in str(gates.get("if", ""))


def test_checks_job_has_exact_aggregate_contract() -> None:
    """TW3: the aggregate declares every dependency and the exact class flags."""

    loaded: object = yaml.safe_load(
        (_REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    )
    assert isinstance(loaded, dict)
    jobs = cast(dict[str, dict[str, object]], loaded["jobs"])
    checks = jobs["checks"]
    assert checks["if"] == "always()"
    assert _needs_values(checks) == {*_ALWAYS, *_FULL_ONLY}

    steps = cast(list[dict[str, object]], checks["steps"])
    gate_step = next(step for step in steps if "ci_gate_result.py" in str(step.get("run", "")))
    assert cast(dict[str, str], gate_step["env"]) == {
        "MODE": "${{ needs.classify.outputs.mode }}",
        "NEEDS_JSON": "${{ toJSON(needs) }}",
    }
    assert str(gate_step["run"]).split() == [
        "python3",
        "snowflake/ci_gate_result.py",
        "--always",
        "gates",
        "--always",
        "classify",
        "--full-only",
        "playwright",
        "--full-only",
        "snowflake-migrations",
        "--full-only",
        "mutation-testing",
    ]


@pytest.mark.parametrize("workflow_name", ["codeql.yml", "dependency-review.yml"])
def test_external_security_workflows_remain_unclassified(workflow_name: str) -> None:
    """TW4: independent security workflows remain always-on and untouched."""

    source = (_REPO / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
    assert "classify" not in source
    assert "needs.classify" not in source
    assert "ci_gate_result" not in source


def test_helper_file_is_present_at_its_exact_regular_repository_path() -> None:
    """Future deletion or replacement with a symlink cannot strand aggregate CI."""

    metadata = _SCRIPT.lstat()
    assert not _SCRIPT.is_symlink()
    assert stat.S_ISREG(metadata.st_mode)


def test_helper_file_presence_rejects_a_symlink_mutation(tmp_path: Path) -> None:
    """A real helper-path symlink fails closed, then restores from scratch only."""

    scratch_copy = tmp_path / _SCRIPT.name
    shutil.copy2(_SCRIPT, scratch_copy)
    try:
        _SCRIPT.unlink()
        _SCRIPT.symlink_to(scratch_copy)
        with pytest.raises(AssertionError):
            test_helper_file_is_present_at_its_exact_regular_repository_path()
    finally:
        _SCRIPT.unlink(missing_ok=True)
        shutil.copy2(scratch_copy, _SCRIPT)


def _import_roots(source: str) -> set[str]:
    """Return root module names imported by a source file's AST."""

    roots: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            roots.add(node.module.split(".")[0])
    return roots


def test_helper_imports_only_stdlib_and_has_no_template_network_or_environment_dump_surface() -> (
    None
):
    """The helper is dependency-free and cannot fetch, spawn, or dump its environment."""

    source = _SCRIPT.read_text(encoding="utf-8")
    roots = _import_roots(source)
    assert roots <= sys.stdlib_module_names | {"__future__"}
    assert "${{" not in source
    assert "subprocess" not in roots
    assert not ({"socket", "urllib", "http", "requests"} & roots)
    tree = ast.parse(source)
    assert not any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Attribute)
        and isinstance(node.func.value.value, ast.Name)
        and node.func.value.value.id == "os"
        and node.func.value.attr == "environ"
        and node.func.attr in {"items", "values", "keys", "copy"}
        for node in ast.walk(tree)
    )


def _arguments(
    always: Sequence[str] = _ALWAYS,
    full_only: Sequence[str] = _FULL_ONLY,
    docs_only: Sequence[str] = (),
) -> list[str]:
    """Build repeatable frozen-interface arguments in deterministic order."""

    arguments: list[str] = []
    for option, job_ids in (
        ("--always", always),
        ("--full-only", full_only),
        ("--docs-only", docs_only),
    ):
        for job_id in job_ids:
            arguments.extend((option, job_id))
    return arguments


def _environment(mode: str | None, results: Mapping[str, object] | None) -> dict[str, str]:
    """Build the gate's two environment inputs."""

    environment: dict[str, str] = {}
    if mode is not None:
        environment["MODE"] = mode
    if results is not None:
        environment["NEEDS_JSON"] = json.dumps(results)
    return environment


def _needs(**results: str) -> dict[str, object]:
    """Build a valid GitHub Actions needs object."""

    return {job_id: {"result": result} for job_id, result in results.items()}


def _cloud_needs(*, full_only_result: str) -> dict[str, object]:
    """Build the cloud aggregate dependency set with one full-only result."""

    return _needs(
        gates="success",
        classify="success",
        playwright=full_only_result,
        **{
            "snowflake-migrations": full_only_result,
            "mutation-testing": full_only_result,
        },
    )


def _assert_failure(
    capsys: pytest.CaptureFixture[str],
    arguments: Sequence[str],
    environment: Mapping[str, str],
) -> str:
    """Assert the fail-closed exit and bounded diagnostic."""

    assert gate.main(arguments, environment) == 1
    output = capsys.readouterr().out
    assert output.startswith("mode=")
    assert "job\texpected\tactual\n" in output
    return output


def test_parse_arguments_help_uses_the_module_contract(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The frozen parser retains its module-level contract description."""

    with pytest.raises(SystemExit) as result:
        gate._parse_arguments(["--help"])
    assert result.value.code == 0
    assert "Fail closed when declared CI jobs do not match" in capsys.readouterr().out


@pytest.mark.parametrize("mode", [None, ""])
def test_failure_formats_missing_mode_and_every_row_exactly(
    capsys: pytest.CaptureFixture[str], mode: str | None
) -> None:
    """The bounded diagnostic is stable and does not erase missing mode."""

    assert gate._failure(mode, (("job", "success", "failure"),)) == 1
    assert capsys.readouterr().out == (
        "mode=<missing>\njob\texpected\tactual\njob\tsuccess\tfailure\n"
    )


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        (
            ["--always", ""],
            ({}, ("<configuration>", "non-empty job id", "empty job id")),
        ),
        (
            ["--always", "same", "--full-only", "same"],
            ({}, ("<configuration>", "unique job id", "same")),
        ),
        (
            [],
            ({}, ("<configuration>", "at least one declared job", "none")),
        ),
    ],
)
def test_declared_job_configuration_errors_are_exact(
    arguments: list[str],
    expected: tuple[dict[str, str], tuple[str, str, str]],
) -> None:
    """Configuration failures retain exact bounded diagnostic rows."""

    assert gate._declared_jobs(gate._parse_arguments(arguments)) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, (None, ("<needs>", "non-empty JSON object", "missing or empty"))),
        ("", (None, ("<needs>", "non-empty JSON object", "missing or empty"))),
        ("not-json", (None, ("<needs>", "JSON object", "invalid JSON"))),
        ("[]", (None, ("<needs>", "JSON object", "list"))),
    ],
)
def test_needs_decode_errors_are_exact(
    raw: str | None,
    expected: tuple[dict[str, object] | None, tuple[str, str, str] | None],
) -> None:
    """Each malformed JSON class has one exact fail-closed diagnostic."""

    assert gate._load_needs(raw) == expected


def test_evaluate_reports_every_malformed_received_entry() -> None:
    """Malformed rows cannot hide later failures through loop short-circuiting."""

    namespace = gate._parse_arguments(
        ["--always", "first", "--always", "second", "--always", "after"]
    )
    accepted, rows = gate._evaluate(
        namespace,
        _environment(
            "full",
            {
                "bad-object": "success",
                "bad-result": {"result": 1},
                "bad-value": {"result": "future"},
                "undeclared": {"result": "success"},
                "after": {"result": "failure"},
            },
        ),
    )
    assert not accepted
    assert rows == (
        ("bad-object", "object with string result", "str"),
        ("bad-result", "string result", "int"),
        ("bad-value", "success, failure, cancelled, or skipped", "future"),
        ("undeclared", "declared job", "success"),
        ("after", "success", "failure"),
        ("first", "success", "missing"),
        ("second", "success", "missing"),
    )


def test_evaluate_handles_defensive_inconsistent_needs_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The defensive needs-none branch remains fail-closed even without an error row."""

    monkeypatch.setattr(gate, "_load_needs", lambda _raw: (None, None))
    accepted, rows = gate._evaluate(
        gate._parse_arguments(["--always", "gates"]),
        {"MODE": "full", "NEEDS_JSON": "{}"},
    )
    assert not accepted
    assert rows == ()


def test_docs_only_accepts_skipped_full_only_and_successful_always_jobs() -> None:
    """TG1: the exact docs-only matrix passes."""

    assert gate.main(_arguments(), _environment("docs-only", _cloud_needs(full_only_result="skipped"))) == 0


def test_full_accepts_all_successful_jobs() -> None:
    """TG2: the exact full matrix passes."""

    assert gate.main(_arguments(), _environment("full", _cloud_needs(full_only_result="success"))) == 0


def test_full_rejects_a_failed_full_only_job(capsys: pytest.CaptureFixture[str]) -> None:
    """TG3: a failed expensive job fails the aggregate."""

    needs = _cloud_needs(full_only_result="success")
    needs["playwright"] = {"result": "failure"}
    output = _assert_failure(capsys, _arguments(), _environment("full", needs))
    assert output.startswith("mode=full\n")
    assert "playwright\tsuccess\tfailure" in output


def test_docs_only_rejects_a_full_only_job_that_ran(capsys: pytest.CaptureFixture[str]) -> None:
    """TG4: bypassing the skip gate fails the aggregate."""

    output = _assert_failure(
        capsys,
        _arguments(),
        _environment("docs-only", _cloud_needs(full_only_result="success")),
    )
    assert "playwright\tskipped\tsuccess" in output


def test_rejects_a_skipped_always_job(capsys: pytest.CaptureFixture[str]) -> None:
    """TG5: gates and classify must always succeed."""

    needs = _cloud_needs(full_only_result="skipped")
    needs["gates"] = {"result": "skipped"}
    output = _assert_failure(capsys, _arguments(), _environment("docs-only", needs))
    assert "gates\tsuccess\tskipped" in output


@pytest.mark.parametrize("mode", ["", None])
def test_missing_mode_fails_closed(
    capsys: pytest.CaptureFixture[str], mode: str | None
) -> None:
    """TG6: a failed classifier cannot leave an empty mode that greens CI."""

    output = _assert_failure(
        capsys,
        _arguments(),
        _environment(mode, _cloud_needs(full_only_result="skipped")),
    )
    assert "<mode>\tfull or docs-only\t<missing>" in output


@pytest.mark.parametrize(
    "environment",
    [
        {"MODE": "full"},
        {"MODE": "full", "NEEDS_JSON": ""},
        {"MODE": "full", "NEEDS_JSON": "not-json"},
        {"MODE": "full", "NEEDS_JSON": "[]"},
    ],
)
def test_missing_invalid_or_non_dict_needs_json_fails_closed(
    capsys: pytest.CaptureFixture[str], environment: dict[str, str]
) -> None:
    """TG7: malformed aggregate input is never an exemption."""

    output = _assert_failure(capsys, _arguments(), environment)
    assert "not-json" not in output


def test_declared_job_missing_from_needs_fails_closed(capsys: pytest.CaptureFixture[str]) -> None:
    """TG8: every declared dependency must be received."""

    needs = _cloud_needs(full_only_result="success")
    del needs["playwright"]
    output = _assert_failure(capsys, _arguments(), _environment("full", needs))
    assert "playwright\tsuccess\tmissing" in output


def test_undeclared_job_in_needs_fails_closed(capsys: pytest.CaptureFixture[str]) -> None:
    """TG9: no aggregate dependency may escape classification."""

    needs = _cloud_needs(full_only_result="success")
    needs["unexpected"] = {"result": "success"}
    output = _assert_failure(capsys, _arguments(), _environment("full", needs))
    assert "unexpected\tdeclared job\tsuccess" in output


@pytest.mark.parametrize("result", ["neutral", "timed_out", ""])
def test_out_of_set_result_fails_closed(
    capsys: pytest.CaptureFixture[str], result: str
) -> None:
    """TG10: only the closed Actions result set is admitted."""

    needs = _cloud_needs(full_only_result="success")
    needs["playwright"] = {"result": result}
    output = _assert_failure(capsys, _arguments(), _environment("full", needs))
    assert "playwright\tsuccess, failure, cancelled, or skipped" in output


def test_internal_exception_fails_closed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """TG12: internal uncertainty preserves nonzero gate polarity."""

    def explode(*_arguments: object) -> tuple[bool, tuple[tuple[str, str, str], ...]]:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(gate, "_evaluate", explode)
    output = _assert_failure(
        capsys,
        _arguments(),
        _environment("full", _cloud_needs(full_only_result="success")),
    )
    assert output.startswith("mode=full\n")
    assert "<internal>\tsuccessful evaluation\texception" in output


@pytest.mark.parametrize(
    ("mode", "arguments", "results", "expected"),
    [
        ("FULL", _arguments(always=("gates",), full_only=()), _needs(gates="success"), "FULL"),
        (
            "full",
            _arguments(always=(), full_only=(), docs_only=("docs",)),
            _needs(docs="success"),
            "docs\tskipped\tsuccess",
        ),
        (
            "docs-only",
            _arguments(always=(), full_only=(), docs_only=("docs",)),
            _needs(docs="skipped"),
            "docs\tsuccess\tskipped",
        ),
        (
            "full",
            _arguments(always=("gates",), full_only=()),
            _needs(gates="cancelled"),
            "gates\tsuccess\tcancelled",
        ),
    ],
)
def test_additional_closed_matrix_directions(
    capsys: pytest.CaptureFixture[str],
    mode: str,
    arguments: list[str],
    results: dict[str, object],
    expected: str,
) -> None:
    """Pin docs-only classes, cancellation, and case-sensitive modes."""

    output = _assert_failure(capsys, arguments, _environment(mode, results))
    assert expected in output


@pytest.mark.parametrize(
    "results",
    [
        {"gates": "success"},
        {"gates": {"result": None}},
        {"gates": {"result": 1}},
    ],
)
def test_malformed_needs_entries_fail_closed(
    capsys: pytest.CaptureFixture[str], results: dict[str, object]
) -> None:
    """Non-object entries and non-string results fail closed."""

    _assert_failure(
        capsys,
        _arguments(always=("gates",), full_only=()),
        _environment("full", results),
    )


@pytest.mark.parametrize(
    "arguments",
    [
        _arguments(always=(), full_only=()),
        _arguments(always=("gates", "gates"), full_only=()),
        _arguments(always=("gates",), full_only=("gates",)),
        _arguments(always=("",), full_only=()),
    ],
)
def test_empty_or_duplicate_declarations_fail_closed(
    capsys: pytest.CaptureFixture[str], arguments: list[str]
) -> None:
    """Every received job needs exactly one non-empty class."""

    _assert_failure(capsys, arguments, _environment("full", _needs(gates="success")))


def test_failure_output_never_dumps_the_environment(capsys: pytest.CaptureFixture[str]) -> None:
    """Diagnostics report only mode and rows, never unrelated environment values."""

    environment = _environment("full", _needs(gates="failure"))
    environment["TOP_SECRET"] = "do-not-print"
    output = _assert_failure(
        capsys,
        _arguments(always=("gates",), full_only=()),
        environment,
    )
    assert "TOP_SECRET" not in output
    assert "do-not-print" not in output


def test_script_execution_uses_the_frozen_interface() -> None:
    """The standalone helper works without installation."""

    result = subprocess.run(
        [sys.executable, str(_SCRIPT), "--always", "gates"],
        check=False,
        capture_output=True,
        text=True,
        env=_environment("full", _needs(gates="success")),
    )
    assert result.returncode == 0
    assert result.stdout == ""


def test_module_entrypoint_preserves_nonzero_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The script entrypoint propagates the gate result."""

    monkeypatch.setattr(sys, "argv", [str(_SCRIPT), "--always", "gates"])
    monkeypatch.setenv("MODE", "full")
    monkeypatch.setenv("NEEDS_JSON", json.dumps(_needs(gates="failure")))
    with pytest.raises(SystemExit) as result:
        runpy.run_path(str(_SCRIPT), run_name="__main__")
    assert result.value.code == 1
