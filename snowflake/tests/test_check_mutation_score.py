"""Tests for check_mutation_score.py (F1-S9 slice 2, issue #12, acceptance
criterion 1).

Imported via a direct sys.path insert of snowflake/ itself, same reasoning
as the other snowflake/tests/*.py files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_mutation_score  # noqa: E402


class TestComputeMutationScore:
    def test_all_killed_is_a_perfect_score(self) -> None:
        assert check_mutation_score.compute_mutation_score(10, 0) == 1.0

    def test_all_survived_is_a_zero_score(self) -> None:
        assert check_mutation_score.compute_mutation_score(0, 10) == 0.0

    def test_mixed_result_computes_the_ratio(self) -> None:
        assert check_mutation_score.compute_mutation_score(3, 1) == pytest.approx(0.75)

    def test_raises_when_killed_and_survived_are_both_zero(self) -> None:
        # An error condition (broken config / vanished files), never a
        # silent "100% passing" default.
        with pytest.raises(ValueError, match="no mutation score can be computed"):
            check_mutation_score.compute_mutation_score(0, 0)


_FULL_STATS_SHAPE = {
    "killed": 5,
    "survived": 1,
    "total": 6,
    "no_tests": 0,
    "suspicious": 0,
    "timeout": 0,
    "segfault": 0,
}


class TestLoadStats:
    def test_reads_and_parses_valid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "stats.json"
        path.write_text(json.dumps(_FULL_STATS_SHAPE))
        assert check_mutation_score.load_stats(path) == _FULL_STATS_SHAPE

    def test_exits_when_the_file_is_missing(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit, match="could not read mutation stats"):
            check_mutation_score.load_stats(tmp_path / "missing.json")

    def test_exits_on_invalid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "stats.json"
        path.write_text("not valid json{")
        with pytest.raises(SystemExit, match="not valid JSON"):
            check_mutation_score.load_stats(path)

    @pytest.mark.parametrize("missing_key", check_mutation_score.REQUIRED_STATS_KEYS)
    def test_exits_when_any_required_key_is_entirely_missing(
        self, tmp_path: Path, missing_key: str
    ) -> None:
        # Independent factory-security-reviewer finding (F1-S9 slice 2,
        # issue #12): a key entirely ABSENT (not just present with value
        # 0) must fail closed, not silently disable that category's
        # regression check via dict.get's default.
        incomplete = {k: v for k, v in _FULL_STATS_SHAPE.items() if k != missing_key}
        path = tmp_path / "stats.json"
        path.write_text(json.dumps(incomplete))
        with pytest.raises(SystemExit, match="missing expected key"):
            check_mutation_score.load_stats(path)

    def test_reads_fine_with_an_extra_unrecognized_key_present(self, tmp_path: Path) -> None:
        # Over-strict validation (rejecting UNKNOWN extra keys) isn't the
        # goal here -- only MISSING required keys must fail closed. A
        # future mutmut release adding a brand-new category should not
        # break this script before that category is deliberately handled.
        path = tmp_path / "stats.json"
        path.write_text(json.dumps({**_FULL_STATS_SHAPE, "check_was_interrupted_by_user": 0}))
        assert check_mutation_score.load_stats(path)["killed"] == 5


class TestLoadBaseline:
    def test_reads_and_parses_valid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "baseline.json"
        path.write_text(json.dumps({"killed": 5, "survived": 1, "_comment": "x"}))
        result = check_mutation_score.load_baseline(path)
        assert result["killed"] == 5
        assert result["survived"] == 1

    def test_exits_when_the_file_is_missing(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit, match="could not read the mutation baseline"):
            check_mutation_score.load_baseline(tmp_path / "missing.json")

    def test_exits_on_invalid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "baseline.json"
        path.write_text("not valid json{")
        with pytest.raises(SystemExit, match="not valid JSON"):
            check_mutation_score.load_baseline(path)


class TestEvaluate:
    def test_empty_when_the_score_matches_the_baseline_exactly(self) -> None:
        current = {"killed": 353, "survived": 131, "no_tests": 0}
        baseline = {"killed": 353, "survived": 131, "no_tests": 0}
        assert check_mutation_score.evaluate(current, baseline) == []

    def test_empty_when_the_score_improves_on_the_baseline(self) -> None:
        current = {"killed": 400, "survived": 84, "no_tests": 0}
        baseline = {"killed": 353, "survived": 131, "no_tests": 0}
        assert check_mutation_score.evaluate(current, baseline) == []

    def test_flags_a_dropped_mutation_score(self) -> None:
        # Same total (484), but more survivors than the baseline -- a real
        # test-strength regression.
        current = {"killed": 300, "survived": 184, "no_tests": 0}
        baseline = {"killed": 353, "survived": 131, "no_tests": 0}
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 1
        assert "mutation score dropped" in reasons[0]

    def test_flags_a_risen_no_tests_count_even_when_the_score_ratio_looks_fine(self) -> None:
        # The gap this check exists to close: a brand-new, completely
        # untested function produces `no_tests` mutants, not `survived`
        # ones, so killed/survived alone is unchanged here.
        current = {"killed": 353, "survived": 131, "no_tests": 5}
        baseline = {"killed": 353, "survived": 131, "no_tests": 0}
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 1
        assert "no_tests count rose" in reasons[0]

    def test_flags_both_independently_when_both_regress(self) -> None:
        current = {"killed": 300, "survived": 184, "no_tests": 5}
        baseline = {"killed": 353, "survived": 131, "no_tests": 0}
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 2

    def test_missing_no_tests_key_defaults_to_zero_on_both_sides(self) -> None:
        current = {"killed": 353, "survived": 131}
        baseline = {"killed": 353, "survived": 131}
        assert check_mutation_score.evaluate(current, baseline) == []

    @pytest.mark.parametrize("category", ["no_tests", "suspicious", "timeout", "segfault"])
    def test_flags_a_risen_count_in_every_unresolved_category_even_when_the_score_ratio_looks_fine(
        self, category: str
    ) -> None:
        # Codex finding (F1-S9 slice 2, issue #12): an earlier version only
        # checked no_tests -- generalized to every category representing a
        # mutant that completed WITHOUT a clean kill (suspicious/timeout/
        # segfault are just as much a gap in the killed/survived ratio).
        current = {"killed": 353, "survived": 131, category: 3}
        baseline = {"killed": 353, "survived": 131, category: 0}
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 1
        assert f"{category} count rose" in reasons[0]

    def test_flags_multiple_unresolved_categories_independently(self) -> None:
        current = {
            "killed": 353,
            "survived": 131,
            "no_tests": 2,
            "suspicious": 4,
            "timeout": 0,
            "segfault": 0,
        }
        baseline = {
            "killed": 353,
            "survived": 131,
            "no_tests": 0,
            "suspicious": 0,
            "timeout": 0,
            "segfault": 0,
        }
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 2
        assert any("no_tests count rose" in r for r in reasons)
        assert any("suspicious count rose" in r for r in reasons)

    def test_does_not_flag_a_rise_in_check_was_interrupted_by_user(self) -> None:
        # Deliberately excluded from UNRESOLVED_MUTANT_CATEGORIES -- an
        # operational cancellation event, not a property of the diff or
        # test-suite strength.
        current = {
            "killed": 353,
            "survived": 131,
            "check_was_interrupted_by_user": 1,
        }
        baseline = {
            "killed": 353,
            "survived": 131,
            "check_was_interrupted_by_user": 0,
        }
        assert check_mutation_score.evaluate(current, baseline) == []

    def test_does_not_flag_equal_or_improved_unresolved_counts(self) -> None:
        current = {"killed": 353, "survived": 131, "suspicious": 0, "timeout": 0}
        baseline = {"killed": 353, "survived": 131, "suspicious": 2, "timeout": 1}
        assert check_mutation_score.evaluate(current, baseline) == []

    def test_flags_a_dropped_total_even_when_the_ratio_improves(self) -> None:
        # Codex finding (F1-S9 slice 2, issue #12, ready round): the exact
        # evasion this check exists to close -- fewer, easier-to-kill
        # mutants can raise killed/(killed+survived) while genuinely
        # shrinking the testable surface (e.g. a suppressed mutant that
        # disappears from every other count entirely).
        current = {"killed": 300, "survived": 20, "total": 320}
        baseline = {"killed": 353, "survived": 131, "total": 484}
        reasons = check_mutation_score.evaluate(current, baseline)
        assert len(reasons) == 1
        assert "total mutant count dropped" in reasons[0]

    def test_does_not_flag_an_equal_or_grown_total(self) -> None:
        current = {"killed": 353, "survived": 131, "total": 484}
        baseline = {"killed": 353, "survived": 131, "total": 484}
        assert check_mutation_score.evaluate(current, baseline) == []

        current_grown = {"killed": 380, "survived": 140, "total": 520}
        assert check_mutation_score.evaluate(current_grown, baseline) == []

    def test_flags_the_exact_deletion_scenario_where_the_ratio_alone_would_have_passed_silently(
        self,
    ) -> None:
        # Independent factory-security-reviewer finding (F1-S9 slice 2,
        # issue #12): DELETING an entire covered security function removes
        # its mutants entirely, and if that function's OWN mutants were
        # disproportionately SURVIVED (i.e. it was the weakly-tested part
        # of the file), removing it can IMPROVE the ratio on what remains
        # -- deleting weak coverage looks like strengthening the suite.
        # There is no separate killed-count check; the total-drop
        # condition (already tested above) is what catches this. This test
        # proves it against the exact deletion shape: a poorly-tested
        # function worth 60 mutants (10 killed, 50 survived -- a 17% local
        # kill rate) is removed entirely from the 423/154/577 baseline,
        # leaving 413/104/517 at a BETTER ratio (0.799 vs. 0.733) than the
        # baseline -- exactly the silent-pass a ratio-only gate would allow.
        baseline = {"killed": 423, "survived": 154, "total": 577}
        after_deleting_a_weakly_tested_function = {"killed": 413, "survived": 104, "total": 517}
        current_score = check_mutation_score.compute_mutation_score(
            after_deleting_a_weakly_tested_function["killed"],
            after_deleting_a_weakly_tested_function["survived"],
        )
        baseline_score = check_mutation_score.compute_mutation_score(
            baseline["killed"], baseline["survived"]
        )
        # Confirms the scenario is realistic: the ratio alone IMPROVES, so
        # a ratio-only gate would have passed this deletion silently.
        assert current_score > baseline_score

        reasons = check_mutation_score.evaluate(after_deleting_a_weakly_tested_function, baseline)
        assert len(reasons) == 1
        assert "total mutant count dropped" in reasons[0]

    def test_missing_total_key_defaults_to_zero_on_both_sides(self) -> None:
        current = {"killed": 353, "survived": 131}
        baseline = {"killed": 353, "survived": 131}
        assert check_mutation_score.evaluate(current, baseline) == []


class TestMain:
    def _write_stats_and_baseline(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        stats: dict[str, object],
        baseline: dict[str, object],
    ) -> None:
        stats_path = tmp_path / "stats.json"
        baseline_path = tmp_path / "baseline.json"
        stats_path.write_text(json.dumps(stats))
        baseline_path.write_text(json.dumps(baseline))
        monkeypatch.setattr(check_mutation_score, "DEFAULT_STATS_PATH", stats_path)
        monkeypatch.setattr(check_mutation_score, "DEFAULT_BASELINE_PATH", baseline_path)

    def test_returns_0_and_prints_confirmation_when_the_score_holds(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        self._write_stats_and_baseline(
            tmp_path,
            monkeypatch,
            {**_FULL_STATS_SHAPE, "killed": 353, "survived": 131, "total": 484},
            {"killed": 353, "survived": 131, "no_tests": 0},
        )
        assert check_mutation_score.main() == 0
        assert "confirmed: mutation score" in capsys.readouterr().out

    def test_returns_1_and_prints_reasons_when_the_score_dropped(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        self._write_stats_and_baseline(
            tmp_path,
            monkeypatch,
            {**_FULL_STATS_SHAPE, "killed": 300, "survived": 184, "total": 484},
            {"killed": 353, "survived": 131, "no_tests": 0},
        )
        assert check_mutation_score.main() == 1
        stderr = capsys.readouterr().err
        assert "mutation-testing check FAILED" in stderr
        assert "mutation score dropped" in stderr

    def test_returns_1_when_the_current_run_has_zero_killed_and_survived(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # evaluate() itself would raise (via compute_mutation_score) -- main()
        # must catch that and fail closed, not crash with an unhandled
        # traceback that could read as a flaky/inconclusive CI failure rather
        # than a clear, actionable one.
        self._write_stats_and_baseline(
            tmp_path,
            monkeypatch,
            {**_FULL_STATS_SHAPE, "killed": 0, "survived": 0, "total": 0},
            {"killed": 353, "survived": 131, "no_tests": 0},
        )
        assert check_mutation_score.main() == 1
        assert "no mutation score can be computed" in capsys.readouterr().err
