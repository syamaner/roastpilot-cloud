"""Behavioural and structural tests for the path-aware CI classifier."""

from __future__ import annotations

import runpy
import shutil
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import cast

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ci_change_classifier as classifier  # noqa: E402

_REPO = Path(__file__).resolve().parents[2]
if _REPO.name == "snowflake":
    _REPO = _REPO.parent
_BASE = "a" * 40
_HEAD = "b" * 40
_MERGE_BASE = "c" * 40


def _name_status(*fields: bytes) -> bytes:
    """Build a NUL-delimited Git ``--name-status`` payload for one test."""

    return b"\0".join(fields) + b"\0"


def _regular_tree_entry(path: bytes) -> bytes:
    """Build a regular-file ``git ls-tree -z`` record for ``path``."""

    return b"100644 blob " + (b"d" * 40) + b"\t" + path + b"\0"


def _install_git_fixture(
    monkeypatch: pytest.MonkeyPatch,
    diff: bytes,
    *,
    regular_paths: set[tuple[str, bytes]] | None = None,
) -> list[tuple[str, ...]]:
    """Install a deterministic local Git transcript and return its command log."""

    calls: list[tuple[str, ...]] = []
    admitted = regular_paths

    def fake_git(arguments: Iterable[str]) -> bytes:
        command = tuple(arguments)
        calls.append(command)
        if command[:2] == ("cat-file", "-e"):
            return b""
        if command[:1] == ("merge-base",):
            return f"{_MERGE_BASE}\n".encode()
        if command[:2] == ("diff", "-z"):
            return diff
        if command[:2] == ("ls-tree", "-z"):
            commit, path = command[2], command[-1].encode()
            if admitted is None or (commit, path) in admitted:
                return _regular_tree_entry(path)
            return b"120000 blob " + (b"e" * 40) + b"\t" + path + b"\0"
        raise AssertionError(f"unexpected Git command: {command!r}")

    monkeypatch.setattr(classifier, "_run_git", fake_git)
    return calls


def test_run_git_uses_only_the_local_closed_command_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """The subprocess wrapper uses no shell, network, or inherited rendered path list."""

    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append((arguments, kwargs))
        return subprocess.CompletedProcess(arguments, 0, stdout=b"local-output")

    monkeypatch.setattr(classifier.subprocess, "run", fake_run)
    assert classifier._run_git(["merge-base", _BASE, _HEAD]) == b"local-output"  # pyright: ignore[reportPrivateUsage]
    assert calls == [
        (
            ["git", "merge-base", _BASE, _HEAD],
            {"check": True, "stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL},
        )
    ]


@pytest.mark.parametrize("status", [b"A", b"M", b"D"])
def test_classifies_single_allowed_markdown_status_as_docs_only(
    monkeypatch: pytest.MonkeyPatch, status: bytes
) -> None:
    """A, M, and D regular nested Markdown paths are the closed positive set."""

    _install_git_fixture(monkeypatch, _name_status(status, b"docs/nested/change.md"))
    assert (
        classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    )


def test_classifies_multiple_nested_allowed_markdown_paths_as_docs_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-empty mixed A/M/D Markdown-only set remains docs-only."""

    _install_git_fixture(
        monkeypatch,
        _name_status(
            b"A",
            b"docs/guide/first.md",
            b"M",
            b"docs/guide/nested/second.md",
            b"D",
            b"docs/old.md",
        ),
    )
    assert (
        classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    )


@pytest.mark.parametrize("status", [b"R100", b"C100"])
def test_classifies_allowed_rename_and_copy_as_docs_only(
    monkeypatch: pytest.MonkeyPatch, status: bytes
) -> None:
    """Pin defensive pair-status parsing, including currently unwired copies.

    The wired ``git diff --find-renames`` command does not emit ``C100``
    without ``--find-copies``/``-C``. Its case here deliberately verifies the
    parser's fail-closed defensive handling, not reachable production input.
    """

    _install_git_fixture(monkeypatch, _name_status(status, b"docs/old.md", b"docs/new.md"))
    assert (
        classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    )


@pytest.mark.parametrize(
    "fields",
    [
        (b"R100", b"docs/old.md", b"src/new.py"),
        # Defensive parser coverage only: the wired diff omits -C/--find-copies.
        (b"C100", b"src/old.py", b"docs/new.md"),
        (b"A", b"README.md"),
        (b"A", b"package-lock.json"),
        (b"A", b"snowflake/migrations/V1__x.sql"),
        (b"A", b"CLAUDE.md"),
        (b"A", b".github/workflows/ci.yml"),
        (b"A", b".claude/role.md"),
        (b"A", b".codex/config.md"),
        (b"A", b".agents/control.md"),
        (b"A", b"AGENTS.md"),
        (b"A", b"docs/guide.txt"),
        (b"A", b"docs/README.MD"),
        (b"A", b"docs/../escape.md"),
        (b"A", b"docs/./dot.md"),
        (b"A", b"tests/test_example.py"),
        (b"A", b"scripts/tool.py"),
        (b"A", b"pyproject.toml"),
        (b"A", b"uv.lock"),
        (b"A", b"tests/fixtures/contract/example.md"),
        (b"A", b"web/src/page.tsx"),
        (b"A", b"codecov.yml"),
        (b"A", b"docs/unsafe\nmode=docs-only.md"),
        (b"A", b"docs/unsafe=mode.md"),
        (b"A", b"docs/invalid\xff.md"),
    ],
)
def test_boundary_crossing_or_unusual_path_is_full(
    monkeypatch: pytest.MonkeyPatch, fields: tuple[bytes, ...]
) -> None:
    """Every path outside the exact case-sensitive grammar fails closed."""

    _install_git_fixture(monkeypatch, _name_status(*fields))
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


@pytest.mark.parametrize("status", [b"T", b"U", b"X", b"R10", b"R1000"])
def test_unrecognised_or_non_regular_status_is_full(
    monkeypatch: pytest.MonkeyPatch, status: bytes
) -> None:
    """Type changes, unmerged records, and malformed similarity statuses fail closed."""

    fields = (status, b"docs/safe.md")
    _install_git_fixture(monkeypatch, _name_status(*fields))
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


def test_symlink_is_full_even_when_its_path_matches_the_docs_grammar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Git object mode confirmation rejects a docs-path symlink."""

    _install_git_fixture(monkeypatch, _name_status(b"A", b"docs/link.md"), regular_paths=set())
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


def test_docs_path_predicate_rejects_invalid_utf8_directly() -> None:
    """Invalid path bytes fail closed at the predicate boundary itself."""

    assert not classifier._is_docs_markdown_path(b"docs/invalid\xff.md")  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize(
    "payload",
    [b"\xff\0docs/safe.md\0", b"A\0", b"R100\0docs/old.md\0", b"A\0docs/safe.md"],
)
def test_malformed_nul_status_records_are_rejected(payload: bytes) -> None:
    """Truncated, non-ASCII, and unterminated name-status records are unknown."""

    assert classifier._parse_name_status(payload) is None  # pyright: ignore[reportPrivateUsage]


def test_regular_file_confirmation_rejects_an_unexpected_tree_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A path mismatch in the local tree response cannot be treated as regular."""

    def unexpected_tree(_arguments: Sequence[str]) -> bytes:
        return b"100644 blob deadbeef\tother.md\0"

    monkeypatch.setattr(classifier, "_run_git", unexpected_tree)
    assert not classifier._is_regular_file(_HEAD, b"docs/safe.md")  # pyright: ignore[reportPrivateUsage]


def test_regular_file_confirmation_rejects_ambiguous_metadata_spacing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only Git's exact single-space tree metadata grammar is admitted."""

    def ambiguous_tree(_arguments: Sequence[str]) -> bytes:
        return b"100644  blob " + (b"d" * 40) + b"\tdocs/safe.md\0"

    monkeypatch.setattr(classifier, "_run_git", ambiguous_tree)
    assert not classifier._is_regular_file(_HEAD, b"docs/safe.md")  # pyright: ignore[reportPrivateUsage]


def test_regular_file_confirmation_rejects_extra_metadata_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Metadata beyond mode, type, and object id cannot be truncated into validity."""

    path = b"docs/a-very-long-safe-name.md"

    def extra_metadata(_arguments: Sequence[str]) -> bytes:
        return b"100644 blob deadbeef extra\t" + path + b"\0"

    monkeypatch.setattr(classifier, "_run_git", extra_metadata)
    assert not classifier._is_regular_file(_HEAD, path)  # pyright: ignore[reportPrivateUsage]


def test_regular_file_confirmation_strips_the_trailing_suffix_not_a_leading_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pin the ``[:-len]`` suffix strip against mutation to ``[:+len]``."""

    def short_path_tree(_arguments: Sequence[str]) -> bytes:
        return b"100644 blob " + (b"0" * 40) + b"\tdocs/d.md\0"

    monkeypatch.setattr(classifier, "_run_git", short_path_tree)
    assert classifier._is_regular_file(_HEAD, b"docs/d.md") is True  # pyright: ignore[reportPrivateUsage]


def test_regular_file_confirmation_accepts_only_the_exact_commit_and_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The local tree query receives the exact commit and decoded path."""

    calls: list[tuple[str, ...]] = []

    def exact_tree(arguments: Sequence[str]) -> bytes:
        calls.append(tuple(arguments))
        return _regular_tree_entry(b"docs/safe.md")

    monkeypatch.setattr(classifier, "_run_git", exact_tree)
    assert classifier._is_regular_file(_HEAD, b"docs/safe.md")  # pyright: ignore[reportPrivateUsage]
    assert calls == [("ls-tree", "-z", _HEAD, "--", "docs/safe.md")]


@pytest.mark.parametrize(
    "entry",
    [
        ("A", (b"docs/safe.md",)),
        ("M", (b"docs/safe.md",)),
        ("D", (b"docs/safe.md",)),
        ("R100", (b"docs/old.md", b"docs/new.md")),
    ],
)
def test_regular_file_confirmation_failure_is_full_for_every_admitted_status(
    monkeypatch: pytest.MonkeyPatch, entry: tuple[str, tuple[bytes, ...]]
) -> None:
    """No admitted status can bypass the regular-file confirmation."""

    def not_regular(_commit: str, _path: bytes) -> bool:
        return False

    monkeypatch.setattr(classifier, "_is_regular_file", not_regular)
    assert not classifier._entries_are_docs_only([entry], _MERGE_BASE, _HEAD)  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize(
    ("entry", "expected_calls"),
    [
        (("A", (b"docs/safe.md",)), [(_HEAD, b"docs/safe.md")]),
        (
            ("M", (b"docs/safe.md",)),
            [(_MERGE_BASE, b"docs/safe.md"), (_HEAD, b"docs/safe.md")],
        ),
        (("D", (b"docs/safe.md",)), [(_MERGE_BASE, b"docs/safe.md")]),
        (
            ("R100", (b"docs/old.md", b"docs/new.md")),
            [(_MERGE_BASE, b"docs/old.md"), (_HEAD, b"docs/new.md")],
        ),
    ],
)
def test_each_status_checks_the_exact_commit_side(
    monkeypatch: pytest.MonkeyPatch,
    entry: tuple[str, tuple[bytes, ...]],
    expected_calls: list[tuple[str, bytes]],
) -> None:
    """Added/head and deleted/base sides cannot be interchanged or omitted."""

    calls: list[tuple[str, bytes]] = []

    def record(commit: str, path: bytes) -> bool:
        calls.append((commit, path))
        return True

    monkeypatch.setattr(classifier, "_is_regular_file", record)
    assert classifier._entries_are_docs_only([entry], _MERGE_BASE, _HEAD)  # pyright: ignore[reportPrivateUsage]
    assert calls == expected_calls


@pytest.mark.parametrize(
    ("entry", "failing_call"),
    [
        (("M", (b"docs/safe.md",)), (_MERGE_BASE, b"docs/safe.md")),
        (("M", (b"docs/safe.md",)), (_HEAD, b"docs/safe.md")),
        (("R100", (b"docs/old.md", b"docs/new.md")), (_MERGE_BASE, b"docs/old.md")),
        (("R100", (b"docs/old.md", b"docs/new.md")), (_HEAD, b"docs/new.md")),
    ],
)
def test_two_sided_status_requires_both_regular_files(
    monkeypatch: pytest.MonkeyPatch,
    entry: tuple[str, tuple[bytes, ...]],
    failing_call: tuple[str, bytes],
) -> None:
    """Neither side of a modification or rename may satisfy the other side."""

    monkeypatch.setattr(
        classifier,
        "_is_regular_file",
        lambda commit, path: (commit, path) != failing_call,
    )
    assert not classifier._entries_are_docs_only([entry], _MERGE_BASE, _HEAD)  # pyright: ignore[reportPrivateUsage]


def test_empty_entries_and_missing_output_path_are_safe_noops() -> None:
    """Internal empty data and absent GitHub output both retain the full-safe boundary."""

    assert not classifier._entries_are_docs_only([], _MERGE_BASE, _HEAD)  # pyright: ignore[reportPrivateUsage]
    classifier._write_output(classifier.ChangeMode.FULL, None)  # pyright: ignore[reportPrivateUsage]


def test_pair_status_followed_by_another_entry_is_parsed_exactly() -> None:
    """A rename consumes exactly two paths before parsing the next status."""

    assert classifier._parse_name_status(  # pyright: ignore[reportPrivateUsage]
        _name_status(b"R100", b"docs/old.md", b"docs/new.md", b"A", b"docs/added.md")
    ) == (
        ("R100", (b"docs/old.md", b"docs/new.md")),
        ("A", (b"docs/added.md",)),
    )


@pytest.mark.parametrize(
    ("event_name", "base_sha", "head_sha"),
    [
        ("push", _BASE, _HEAD),
        ("pull_request", "", _HEAD),
        ("pull_request", _BASE.upper(), _HEAD),
        ("pull_request", _BASE[:-1], _HEAD),
    ],
)
def test_non_pr_or_malformed_inputs_are_full_without_git(
    monkeypatch: pytest.MonkeyPatch, event_name: str, base_sha: str, head_sha: str
) -> None:
    """Only exact pull-request SHA inputs may reach local Git."""

    calls = _install_git_fixture(monkeypatch, _name_status(b"M", b"docs/safe.md"))
    assert classifier.classify_change(event_name, base_sha, head_sha) is classifier.ChangeMode.FULL
    assert calls == []


@pytest.mark.parametrize("failure", [b"", b"not-a-sha\n"])
def test_empty_or_invalid_merge_base_is_full(
    monkeypatch: pytest.MonkeyPatch, failure: bytes
) -> None:
    """An empty or malformed merge-base result cannot be docs-only."""

    def fake_git(arguments: Iterable[str]) -> bytes:
        command = tuple(arguments)
        if command[:2] == ("cat-file", "-e"):
            return b""
        if command[:1] == ("merge-base",):
            return failure
        raise AssertionError(command)

    monkeypatch.setattr(classifier, "_run_git", fake_git)
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


def test_empty_comparison_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    """A successful but empty merge-base comparison cannot be docs-only."""

    _install_git_fixture(monkeypatch, b"")
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


@pytest.mark.parametrize("failing_command", ["cat-file", "merge-base", "diff", "ls-tree"])
def test_git_failures_and_exceptions_are_full(
    monkeypatch: pytest.MonkeyPatch, failing_command: str
) -> None:
    """Missing objects, diff failure, and any Git exception are fail-closed."""

    def fake_git(arguments: Iterable[str]) -> bytes:
        command = tuple(arguments)
        if command[0] == failing_command:
            raise OSError("unavailable")
        if command[:2] == ("cat-file", "-e"):
            return b""
        if command[:1] == ("merge-base",):
            return f"{_MERGE_BASE}\n".encode()
        if command[:2] == ("diff", "-z"):
            return _name_status(b"A", b"docs/safe.md")
        if command[:2] == ("ls-tree", "-z"):
            return _regular_tree_entry(command[-1].encode())
        raise AssertionError(command)

    monkeypatch.setattr(classifier, "_run_git", fake_git)
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


def test_uses_merge_base_and_exact_nul_name_status_command(monkeypatch: pytest.MonkeyPatch) -> None:
    """The comparison is merge-base-to-head, never a two-dot or rendered path list."""

    calls = _install_git_fixture(monkeypatch, _name_status(b"M", b"docs/safe.md"))
    assert (
        classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    )
    assert ("merge-base", _BASE, _HEAD) in calls
    assert (
        "diff",
        "-z",
        "--name-status",
        "--find-renames",
        "--no-color",
        _MERGE_BASE,
        _HEAD,
    ) in calls
    assert ("ls-tree", "-z", _MERGE_BASE, "--", "docs/safe.md") in calls


def test_real_git_diff_and_tree_output_matches_classifier(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real NUL-delimited Git output admits docs only and rejects unsafe entries."""

    if shutil.which("git") is None:
        pytest.skip("git is unavailable")

    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    monkeypatch.chdir(repo)

    def git(*arguments: str) -> str:
        completed = subprocess.run(
            ["git", *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return completed.stdout.strip()

    git("config", "user.email", "classifier-test@example.invalid")
    git("config", "user.name", "CI classifier test")
    docs = repo / "docs"
    docs.mkdir()
    (docs / "existing.md").write_text("before\n", encoding="utf-8")
    (docs / "old.md").write_text("delete me\n", encoding="utf-8")
    (docs / "rename-old.md").write_text("rename me\n", encoding="utf-8")
    git("add", "docs")
    git("commit", "--quiet", "-m", "initial docs")
    first_sha = git("rev-parse", "HEAD")

    (docs / "new.md").write_text("new\n", encoding="utf-8")
    (docs / "existing.md").write_text("after\n", encoding="utf-8")
    (docs / "old.md").unlink()
    git("mv", "docs/rename-old.md", "docs/rename-new.md")
    git("add", "--all")
    git("commit", "--quiet", "-m", "mixed docs operations")
    second_sha = git("rev-parse", "HEAD")

    assert (
        classifier.classify_change("pull_request", first_sha, second_sha)
        is classifier.ChangeMode.DOCS_ONLY
    )

    source = repo / "src"
    source.mkdir()
    (source / "app.py").write_text("print('unsafe')\n", encoding="utf-8")
    git("add", "--all")
    git("commit", "--quiet", "-m", "add non-doc")
    third_sha = git("rev-parse", "HEAD")

    assert (
        classifier.classify_change("pull_request", second_sha, third_sha)
        is classifier.ChangeMode.FULL
    )

    git("checkout", "--quiet", "--detach", second_sha)
    (docs / "link.md").symlink_to("new.md")
    git("add", "--all")
    git("commit", "--quiet", "-m", "add docs symlink")
    symlink_sha = git("rev-parse", "HEAD")

    assert (
        classifier.classify_change("pull_request", second_sha, symlink_sha)
        is classifier.ChangeMode.FULL
    )


def test_classify_passes_exact_merge_base_and_head_to_entry_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The final regular-file check receives both immutable comparison commits."""

    calls = _install_git_fixture(monkeypatch, _name_status(b"A", b"docs/safe.md"))
    received: list[tuple[object, str, str]] = []

    def accept(entries: object, merge_base: str, head_sha: str) -> bool:
        received.append((entries, merge_base, head_sha))
        return True

    monkeypatch.setattr(classifier, "_entries_are_docs_only", accept)
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    assert received == [((("A", (b"docs/safe.md",)),), _MERGE_BASE, _HEAD)]
    assert ("merge-base", _BASE, _HEAD) in calls


@pytest.mark.parametrize("missing", ["--event-name", "--base-sha", "--head-sha"])
def test_parse_arguments_requires_each_input(missing: str) -> None:
    """Every frozen CLI input is independently required."""

    complete = {
        "--event-name": "pull_request",
        "--base-sha": _BASE,
        "--head-sha": _HEAD,
    }
    arguments = [item for pair in complete.items() if pair[0] != missing for item in pair]
    with pytest.raises(SystemExit):
        classifier._parse_arguments(arguments)  # pyright: ignore[reportPrivateUsage]


def test_parse_arguments_help_uses_the_module_contract(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The parser retains its module-level contract description."""

    with pytest.raises(SystemExit) as result:
        classifier._parse_arguments(["--help"])  # pyright: ignore[reportPrivateUsage]
    assert result.value.code == 0
    assert "Classify a pull request diff as closed docs-only or full CI work." in capsys.readouterr().out


def test_main_writes_one_closed_output_line_without_raw_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Workflow output has exactly the two-token closed grammar and no path data."""

    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    _install_git_fixture(monkeypatch, _name_status(b"A", b"docs/safe.md"))
    assert (
        classifier.main(["--event-name", "pull_request", "--base-sha", _BASE, "--head-sha", _HEAD])
        == 0
    )
    assert output.read_text(encoding="utf-8") == "mode=docs-only\n"
    assert "docs/safe.md" not in output.read_text(encoding="utf-8")


def test_main_converts_an_unexpected_exception_to_full_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The command boundary never raises an unexpected classifier exception."""

    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))

    def explode(*_args: object) -> classifier.ChangeMode:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(classifier, "classify_change", explode)
    assert (
        classifier.main(["--event-name", "pull_request", "--base-sha", _BASE, "--head-sha", _HEAD])
        == 0
    )
    assert output.read_text(encoding="utf-8") == "mode=full\n"


@pytest.mark.parametrize(
    "arguments",
    [
        ["--event-name", "pull_request", "--head-sha", _HEAD],
        ["--event-name", "pull_request", "--base-sha", _BASE],
    ],
)
def test_main_converts_missing_required_sha_to_full_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, arguments: list[str]
) -> None:
    """Missing required SHA flags exit cleanly after emitting the full-safe mode."""

    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    assert classifier.main(arguments) == 0
    assert output.read_text(encoding="utf-8") == "mode=full\n"


def test_main_suppresses_a_secondary_output_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unavailable output sink cannot raise through the workflow boundary."""

    def explode(*_args: object) -> classifier.ChangeMode:
        raise RuntimeError("unexpected")

    def fail_output(*_args: object) -> None:
        raise OSError("unavailable")

    monkeypatch.setattr(classifier, "classify_change", explode)
    monkeypatch.setattr(classifier, "_write_output", fail_output)
    assert (
        classifier.main(["--event-name", "pull_request", "--base-sha", _BASE, "--head-sha", _HEAD])
        == 0
    )


def test_module_entrypoint_exits_cleanly(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The committed script entrypoint keeps its failure-safe zero exit boundary."""

    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "ci_change_classifier.py",
            "--event-name",
            "push",
            "--base-sha",
            _BASE,
            "--head-sha",
            _HEAD,
        ],
    )
    with pytest.raises(SystemExit) as result:
        runpy.run_path(str(_REPO / "snowflake" / "ci_change_classifier.py"), run_name="__main__")
    assert result.value.code == 0
    assert output.read_text(encoding="utf-8") == "mode=full\n"


def test_registry_markdown_only_is_docs_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """The cloud registry path alone is inside the closed docs grammar."""

    _install_git_fixture(monkeypatch, _name_status(b"M", b"docs/state/registry.md"))
    assert (
        classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.DOCS_ONLY
    )


def test_registry_markdown_paired_with_code_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    """An admitted docs path cannot hide a code change in the same comparison."""

    _install_git_fixture(
        monkeypatch,
        _name_status(b"M", b"docs/state/registry.md", b"M", b"app/page.tsx"),
    )
    assert classifier.classify_change("pull_request", _BASE, _HEAD) is classifier.ChangeMode.FULL


def test_ci_classifier_job_is_consumed_and_uses_closed_checkout_settings() -> None:
    """The classifier is wired to every full-only cloud CI job."""

    loaded: object = yaml.safe_load(
        (_REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    )
    assert isinstance(loaded, dict)
    jobs = cast(dict[str, dict[str, object]], loaded["jobs"])
    classify = jobs["classify"]
    assert cast(dict[str, str], classify["outputs"]) == {
        "mode": "${{ steps.classify.outputs.mode }}"
    }
    steps = cast(list[dict[str, object]], classify["steps"])
    checkout = steps[0]
    assert checkout["uses"] == (
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
    )
    assert checkout["with"] == {"fetch-depth": 0, "persist-credentials": False}
    assert steps[1]["uses"] == "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1"
    assert steps[1]["with"] == {"python-version": "3.11"}
    classifier_step = steps[2]
    assert classifier_step["env"] == {
        "EVENT_NAME": "${{ github.event_name }}",
        "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
        "HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
    }
    assert classifier_step["run"] == (
        'python3 snowflake/ci_change_classifier.py --event-name "$EVENT_NAME" '
        '--base-sha "$BASE_SHA" --head-sha "$HEAD_SHA"'
    )
    for name in ("playwright", "snowflake-migrations", "mutation-testing"):
        job = jobs[name]
        needs = job["needs"]
        needs_values = {needs} if isinstance(needs, str) else set(cast(list[str], needs))
        assert "classify" in needs_values
        assert job["if"] == "${{ needs.classify.outputs.mode != 'docs-only' }}"

    gates = jobs["gates"]
    gates_needs = gates.get("needs", [])
    gates_values = {gates_needs} if isinstance(gates_needs, str) else set(
        cast(list[str], gates_needs)
    )
    assert "classify" not in gates_values
    assert "needs.classify.outputs.mode" not in str(gates.get("if", ""))
