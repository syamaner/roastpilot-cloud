#!/usr/bin/env python3
"""Gates the mutation-testing job on a dropped mutation score (F1-S9 slice 2,
issue #12, acceptance criterion 1).

`mutmut run` itself ALWAYS exits 0 regardless of how many mutants survived —
verified empirically against this repo's own two security-critical files (a
config error, e.g. a missing/malformed `pyproject.toml`, DOES exit non-zero;
only the mutant-survival outcome itself is silent). This script is the actual
gate: it reads `mutmut export-cicd-stats`'s JSON output, compares the current
run's mutation score against the committed baseline
(`mutation-baseline.json`), and fails closed on either of two conditions:

1. The mutation score (`killed / (killed + survived)`) dropped below the
   baseline's score — the acceptance criterion's literal ask ("a dropped
   mutation score... fails the check").
2. Any UNRESOLVED-mutant category (Codex finding, F1-S9 slice 2, issue #12 —
   generalizes an earlier version that checked only `no_tests`) rose above
   its baseline count. `killed`/`survived` aren't the only outcomes mutmut
   reports: `no_tests` (mutmut found no test to run against the mutant at
   all — newly added, completely untested code), `suspicious` (the mutant's
   test run behaved inconsistently — completed without being definitively
   killed, e.g. a flaky result), `timeout` (the mutant run exceeded its
   time budget without a clear kill), and `segfault` (the interpreter
   crashed running it) all represent a mutant that did NOT return a clean
   "killed" result, yet none of them appear in the `killed`/`survived`
   ratio at all. A PR that adds a brand-new, completely untested function
   produces `no_tests` mutants, not `survived` ones — the ratio alone could
   stay unchanged (or even improve) while genuinely uncovered new security
   logic lands; the same blind spot applies to a change that makes an
   existing test flaky/inconsistent against a mutant (`suspicious`) instead
   of reliably killing it. `UNRESOLVED_MUTANT_CATEGORIES` names every such
   category explicitly rather than deriving them by exclusion, so a future
   mutmut release adding a new outcome category is a visible one-line
   addition here, not a silent gap.

Both checks are necessary; neither alone catches everything the other does.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_STATS_PATH = Path("mutants/mutmut-cicd-stats.json")
DEFAULT_BASELINE_PATH = Path("mutation-baseline.json")

# Every mutmut outcome category OTHER than killed/survived that represents a
# mutant NOT definitively killed by the test suite (Codex finding, F1-S9
# slice 2, issue #12) — see this module's own docstring, point 2, for why
# each of these needs the same "must not rise above baseline" treatment as
# `no_tests` alone got in an earlier version. Named explicitly (not derived
# by excluding killed/survived/total from whatever keys happen to be in the
# stats JSON) so a future mutmut release adding a new category is a visible,
# reviewed one-line addition here, never a silent gap.
#
# Deliberately EXCLUDES `check_was_interrupted_by_user`: that category
# reflects an OPERATIONAL event (someone/something cancelled the run, e.g.
# a CI job cancellation), not a property of the diff or the test suite's
# strength -- gating on it would fail a re-run for reasons unrelated to any
# code change, and a genuine re-run naturally resets it to 0 anyway.
UNRESOLVED_MUTANT_CATEGORIES = ("no_tests", "suspicious", "timeout", "segfault")


def compute_mutation_score(killed: int, survived: int) -> float:
    """Computes the mutation score for one killed/survived pair.

    @param killed: Number of mutants the test suite killed.
    @param survived: Number of mutants that survived (a test-strength gap).
    @returns: `killed / (killed + survived)`, in `[0.0, 1.0]`.
    @raises ValueError: If `killed + survived` is zero — there is no
        meaningful score to compute (either the covered files vanished, or
        the mutmut config is broken and generated zero mutants; both are
        errors this script must never silently treat as "100% passing").
    """
    denominator = killed + survived
    if denominator <= 0:
        raise ValueError(
            f"killed ({killed}) + survived ({survived}) is {denominator} -- "
            "no mutants were killed or survived, so no mutation score can be "
            "computed. This is an error condition (a broken mutmut config, "
            "or the covered files disappearing), never a passing result."
        )
    return killed / denominator


def load_stats(path: Path) -> dict[str, object]:
    """Reads and parses `mutmut export-cicd-stats`'s JSON output.

    @param path: Path to the stats JSON file.
    @returns: The parsed JSON object.
    @raises SystemExit: If the file is missing or not valid JSON -- a
        missing/corrupt stats file means the mutation-testing run itself
        didn't complete as expected, which must fail the check, not be
        silently skipped.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise SystemExit(
            f"error: could not read mutation stats at {path} ({err}) -- did "
            "`mutmut run` + `mutmut export-cicd-stats` run before this step?"
        ) from err
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise SystemExit(
            f"error: {path} is not valid JSON ({err}) -- mutmut's own "
            "export-cicd-stats output format may have changed"
        ) from err


def load_baseline(path: Path) -> dict[str, object]:
    """Reads and parses the committed mutation-score baseline.

    @param path: Path to the baseline JSON file.
    @returns: The parsed JSON object (including its own `_comment` key,
        which callers reading `killed`/`survived`/`total` simply ignore).
    @raises SystemExit: If the file is missing or not valid JSON.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise SystemExit(
            f"error: could not read the mutation baseline at {path} ({err}) "
            "-- this file must be committed to the repo"
        ) from err
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise SystemExit(f"error: {path} is not valid JSON ({err})") from err


# Human-readable descriptions for each of UNRESOLVED_MUTANT_CATEGORIES,
# used only to build evaluate()'s failure messages.
_UNRESOLVED_CATEGORY_DESCRIPTIONS = {
    "no_tests": "had no test touch them at all",
    "suspicious": "completed with an inconsistent/flaky test result, never a clean kill",
    "timeout": "exceeded the per-mutant time budget without a clean kill",
    "segfault": "crashed the interpreter running the mutant",
}


def evaluate(current: dict[str, object], baseline: dict[str, object]) -> list[str]:
    """Compares the current mutation-testing run against the baseline.

    @param current: The parsed `mutmut export-cicd-stats` JSON (this run).
    @param baseline: The parsed `mutation-baseline.json` (the committed
        floor).
    @returns: Human-readable failure reasons, empty if the run passes both
        checks described in this module's own docstring.
    """
    current_killed = int(current.get("killed", 0))
    current_survived = int(current.get("survived", 0))

    baseline_killed = int(baseline.get("killed", 0))
    baseline_survived = int(baseline.get("survived", 0))

    reasons: list[str] = []

    current_score = compute_mutation_score(current_killed, current_survived)
    baseline_score = compute_mutation_score(baseline_killed, baseline_survived)
    if current_score < baseline_score:
        reasons.append(
            f"mutation score dropped: {current_score:.4f} "
            f"({current_killed} killed / {current_killed + current_survived} total) "
            f"is below the baseline {baseline_score:.4f} "
            f"({baseline_killed} killed / {baseline_killed + baseline_survived} total)"
        )

    for category in UNRESOLVED_MUTANT_CATEGORIES:
        current_count = int(current.get(category, 0))
        baseline_count = int(baseline.get(category, 0))
        if current_count > baseline_count:
            description = _UNRESOLVED_CATEGORY_DESCRIPTIONS[category]
            reasons.append(
                f"{category} count rose: {current_count} mutant(s) {description} "
                f"(baseline: {baseline_count}) -- an unresolved mutant the killed/survived "
                "ratio alone would not catch"
            )

    return reasons


def main() -> int:
    stats = load_stats(DEFAULT_STATS_PATH)
    baseline = load_baseline(DEFAULT_BASELINE_PATH)

    try:
        reasons = evaluate(stats, baseline)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    if reasons:
        print(
            "error: mutation-testing check FAILED on the security-critical "
            "grant-boundary surface:",
            file=sys.stderr,
        )
        for reason in reasons:
            print(f"  - {reason}", file=sys.stderr)
        print(
            "  See mutants/mutmut-cicd-stats.json and `mutmut results` (or the uploaded "
            "artifact) for exactly which mutants survived.",
            file=sys.stderr,
        )
        return 1

    current_killed = int(stats.get("killed", 0))
    current_survived = int(stats.get("survived", 0))
    score = compute_mutation_score(current_killed, current_survived)
    print(
        f"confirmed: mutation score {score:.4f} ({current_killed} killed / "
        f"{current_killed + current_survived} total) meets or exceeds the committed baseline"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
