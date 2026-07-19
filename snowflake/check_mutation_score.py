#!/usr/bin/env python3
"""Gates the mutation-testing job on a dropped mutation score (F1-S9 slice 2,
issue #12, acceptance criterion 1).

`mutmut run` itself ALWAYS exits 0 regardless of how many mutants survived —
verified empirically against this repo's own two security-critical files (a
config error, e.g. a missing/malformed `pyproject.toml`, DOES exit non-zero;
only the mutant-survival outcome itself is silent). This script is the actual
gate: it reads `mutmut export-cicd-stats`'s JSON output, compares the current
run's mutation score against the committed baseline
(`mutation-baseline.json`), and fails closed on any of THREE conditions:

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
3. `total` (the number of mutants mutmut GENERATED) dropped below the
   baseline's total (Codex finding, F1-S9 slice 2, issue #12, ready round):
   a mutant that stops being generated at all disappears from every other
   count entirely -- it never becomes `survived`, `no_tests`, or anything
   else checks 1-2 would see. A diff that suppresses mutants outright (e.g.
   mutmut's own `# pragma: no mutate`, or otherwise shrinking the covered
   files' testable surface) can hold the `killed/(killed+survived)` ratio
   steady or even IMPROVE it -- fewer, easier-to-kill mutants raise the
   ratio -- while genuinely removing mutation coverage. A legitimate
   refactor that shrinks these files is still possible; the honest path for
   that is a CONSCIOUS `mutation-baseline.json` update in the same PR
   (reviewed, auditable), not a silent pass against a stale, now-inflated
   baseline.

All three checks are necessary; none alone catches everything the others do.

CONFIRMED (independent factory-security-reviewer finding, F1-S9 slice 2,
issue #12 -- "does the gate fail on a killed-count DROP specifically, or
only via score+total?"): there is no separate `killed`-count-drop check,
and none is needed -- condition 3 (the `total` check above) already
catches the exact exploit that finding named: DELETING an entire covered
security function. Removing a function's code removes ITS mutants from
the count entirely, so `total` drops; `killed` alone dropping while
`survived` drops by the same or a greater amount (a plausible shape if the
deleted function's own mutants were disproportionately hard-to-kill) could
otherwise look score-neutral or score-improving, exactly like the
mutant-suppression case condition 3 already targets. See
`test_check_mutation_score.py`'s own explicit deletion-scenario test for
the empirical proof, not just this claim.
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


# Every top-level key `evaluate()` reads from the CURRENT run's stats JSON
# (independent factory-security-reviewer finding, F1-S9 slice 2, issue #12
# — "assert the expected keys exist, fail closed, like the killed/survived
# path already does"): `dict.get(key, 0)` silently treats a MISSING key
# the same as a key that's genuinely present with value 0, which means a
# future mutmut release renaming (or dropping) one of these -- e.g.
# `suspicious` becoming `flaky` -- would silently disable that category's
# entire regression check rather than visibly failing. `load_stats`
# validates every one of these is a literal key in the parsed JSON before
# `evaluate()` ever sees it, closing that gap categorically rather than
# per-field.
REQUIRED_STATS_KEYS = ("killed", "survived", "total", *UNRESOLVED_MUTANT_CATEGORIES)


def load_stats(path: Path) -> dict[str, object]:
    """Reads, parses, and validates `mutmut export-cicd-stats`'s JSON output.

    @param path: Path to the stats JSON file.
    @returns: The parsed JSON object.
    @raises SystemExit: If the file is missing, not valid JSON, or missing
        any of {@link REQUIRED_STATS_KEYS} -- a missing/corrupt/malformed
        stats file means the mutation-testing run itself didn't complete
        as expected, or mutmut's own output shape changed, either of
        which must fail the check, not be silently skipped or partially
        checked.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise SystemExit(
            f"error: could not read mutation stats at {path} ({err}) -- did "
            "`mutmut run` + `mutmut export-cicd-stats` run before this step?"
        ) from err
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise SystemExit(
            f"error: {path} is not valid JSON ({err}) -- mutmut's own "
            "export-cicd-stats output format may have changed"
        ) from err
    missing = [key for key in REQUIRED_STATS_KEYS if key not in parsed]
    if missing:
        raise SystemExit(
            f"error: {path} is missing expected key(s) {missing} -- mutmut's own "
            "export-cicd-stats output format may have changed. Failing closed rather "
            "than silently defaulting a missing category to 0, which would disable "
            "its regression check entirely without any visible signal."
        )
    return parsed


def load_baseline(path: Path) -> dict[str, object]:
    """Reads, parses, and validates the committed mutation-score baseline.

    Mirrors `load_stats`'s fail-closed key validation (independent
    factory-security-reviewer finding, F1-S9 slice 2, issue #12): unlike
    the stats JSON, which `mutmut export-cicd-stats` generates fresh every
    run, this file is committed, diff-editable content -- a rebaseline
    commit (legitimate or an agent patch trying to game the gate) that
    OMITS a field silently disables that field's own regression check via
    `evaluate()`'s `dict.get(key, 0)` defaults, rather than visibly
    failing. A missing `total`, for example, defaults `baseline_total` to
    0, a floor no future run's real `total` can ever measure below --
    exactly the "green by construction" exploit this whole gate exists to
    prevent. Every `REQUIRED_STATS_KEYS` field must be present here too,
    even when it's legitimately 0 (see `mutation-baseline.json`'s own
    `_comment`, which now records all four `UNRESOLVED_MUTANT_CATEGORIES`
    explicitly for exactly this reason).

    Also validates every one of those fields is a non-negative integer
    (not a string, float, `null`, or `bool` -- `bool` is a Python `int`
    subclass, so `isinstance(x, int)` alone would silently accept `true`/
    `false` as if they were `1`/`0`, checked separately below). A
    malformed or negative value would otherwise reach `evaluate()`'s own
    `int(...)` coercion, which either raises an unhandled, unhelpful
    exception mid-comparison or -- for a value already an `int` subtype,
    like `bool` -- coerces silently into a nonsensical baseline.

    @param path: Path to the baseline JSON file.
    @returns: The parsed JSON object (including its own `_comment` key,
        which callers reading `killed`/`survived`/`total` simply ignore).
    @raises SystemExit: If the file is missing, not valid JSON, missing
        any of `REQUIRED_STATS_KEYS`, or has a non-integer/negative value
        for any of them.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as err:
        raise SystemExit(
            f"error: could not read the mutation baseline at {path} ({err}) "
            "-- this file must be committed to the repo"
        ) from err
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise SystemExit(f"error: {path} is not valid JSON ({err})") from err

    missing = [key for key in REQUIRED_STATS_KEYS if key not in parsed]
    if missing:
        raise SystemExit(
            f"error: {path} is missing expected key(s) {missing} -- a rebaseline that "
            "omits a field silently disables that field's own regression check (a "
            "missing 'total', for example, defaults to 0, a floor no future run can "
            "ever measure below). Every REQUIRED_STATS_KEYS field must be present and "
            "explicit here, even when it's legitimately 0."
        )
    invalid = [
        key
        for key in REQUIRED_STATS_KEYS
        if isinstance(parsed[key], bool) or not isinstance(parsed[key], int) or parsed[key] < 0
    ]
    if invalid:
        raise SystemExit(
            f"error: {path} has a non-integer or negative value for key(s) {invalid} -- "
            "every REQUIRED_STATS_KEYS field must be a non-negative integer"
        )
    return parsed


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
    current_total = int(current.get("total", 0))

    baseline_killed = int(baseline.get("killed", 0))
    baseline_survived = int(baseline.get("survived", 0))
    baseline_total = int(baseline.get("total", 0))

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

    if current_total < baseline_total:
        reasons.append(
            f"total mutant count dropped: {current_total} generated this run, below the "
            f"baseline's {baseline_total} -- mutants that stop being generated at all "
            "disappear from every other count, so a shrinking testable surface can hold "
            "or even improve the killed/survived ratio while removing real mutation "
            "coverage; if this is a legitimate refactor, update mutation-baseline.json "
            "in this same PR rather than let it pass against a stale baseline"
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
            "  See the uploaded `mutation-testing-stats` artifact's mutmut-survivors.txt "
            "for the exact surviving mutant IDs (or run `mutmut results` locally), then "
            "`mutmut show <mutant-name>` for the full diff of any one of them.",
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
