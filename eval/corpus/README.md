# Held-out factory regression corpus

This directory is a recorded-mode, held-out evaluation corpus. No case content may ever feed a prompt, skill, few-shot example, or prompt/skill edit. Doing so would turn regression measurement into memorisation.

Corpus updates require an operator-authored decision and a reviewed data-only PR. A non-pass evaluation result never updates, replaces, or relaxes the corpus or its expectations.

Replay producers may read only `manifest.json` and `inputs/**`. Scorers alone may read `expectations/**`; producers must never receive expectation content. Issue snapshots, authorized decision context, and recorded artifacts are frozen and are never re-fetched during evaluation.

Some readiness decisions used an operator-authorized story-planner contract posted after the raw issue but before the disposition boundary. For those cases, `decisionContextPath` names a companion input containing the contract's substantive plan, dependencies, sizing, acceptance criteria, and reviewer routing. The companion deliberately excludes disposition recommendations and readiness-label text. Its source timestamp is no later than the issue snapshot's `snapshotAt`, and both precede the recorded verdict boundary. `decisionContextPath` is `null` when no companion input exists.

The issue-snapshot schema remains closed: `issueNumber`, `title`, `body`, `labels`, `state`, `snapshotAt`, and `sourceUrl`. The manifest case schema is also closed and includes `decisionContextPath` immediately beside `issueSnapshotPath`; it is either `null` or byte-equal to `inputs/<caseId>/decision-context.md`.

The corpus has thin autonomous triage history. A recorded verdict is marked `historical-artifact` only when the matching factory-bot/pipeline verdict is preserved. Human/operator dispositions and later readiness outcomes are represented by validator-clean `reconstructed-from-outcome` verdicts. There is no numeric reconstruction cap: reconstructed cases are admissible only when provenance is explicit and their frozen issue plus any authorized pre-verdict decision context independently supports the recorded verdict. This corpus currently contains five matching bot artifacts and seven input-faithful reconstructions; it should shift toward bot artifacts as live history accrues.

The N9 input leak check is case-relative: no input file for a case (issue snapshot, decision context, labels, or recorded patch) may contain that case's own `expected.json.triage.expectedReadiness` label, excluding the schema-required `recorded/triage-verdict.json`. A different readiness label appearing in an issue's own text is faithful historical content, not a leak of that case's answer. Recorded triage-verdict artifacts are excluded because their schema necessarily stores the replayed readiness value; they remain isolated under each `recorded/` directory and are not prompt inputs to a live-provider triage replay.

The `pin` object records the historical repository action pin in force for the case. Null model or prompt/skill versions mean the retained history did not preserve that producer detail; they are never backfilled from a newer run.

## Implement-case size bands

`sizeClass` is a corpus-relative band over the thin-slice factory history represented here, not a claim that a case approaches the factory's 400-line admission ceiling. Logic lines are additions plus deletions with test files excluded, following the repository convention; independently inert data is also excluded where applicable.

- `near-cap` means the upper band actually present in this corpus: the largest captured implement case, `issue-058-grant-hardening` at 119 logic lines.
- `small` means every other captured implement case: `issue-009-registry-reconciliation` at 6 logic lines, `issue-026-health-route-dryrun` at 5 logic lines (15 total textual lines including its test), and `issue-151-summary-binding` at 13 logic lines.
