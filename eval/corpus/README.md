# Held-out factory regression corpus

This directory is a recorded-mode, held-out evaluation corpus. No case content may ever feed a prompt, skill, few-shot example, or prompt/skill edit. Doing so would turn regression measurement into memorisation.

Corpus updates require an operator-authored decision and a reviewed data-only PR. A non-pass evaluation result never updates, replaces, or relaxes the corpus or its expectations.

The harness splits access by role. A replay producer may receive `manifest.json` plus only the case input files required for its stage; scorers alone may read `expectations/**`. A triage producer receives the issue snapshot and optional decision context, never the recorded verdict. Recorded verdicts and patches are stage-bound replay artifacts, not permission for a provider to enumerate the input tree. No producer may receive expectation content. Issue snapshots, authorized decision context, and recorded artifacts are frozen and are never re-fetched during evaluation.

The isolation boundary covers the manifest itself. Its closed top-level schema is `schemaVersion`, `description`, and `cases`. Each producer-readable case has exactly these answer-neutral orchestration fields: `caseId`, `issueNumber`, `prNumber`, `stage`, `baseSha`, `capturedAt`, `pin`, `issueSnapshotPath`, `decisionContextPath`, `recorded`, and `notes`. `recorded` contains only `triageVerdictPath` and `implementPatchPath`; `pin` contains only `actionRef`, `actionCommit`, `resolvedModel`, `triageSkillVersion`, and `implementPromptVersion`. Notes may describe input fidelity or capture mechanics but may not state a readiness, execution, size, CI, mutation, review, merge, or outcome answer. `capturedAt` is the answer-neutral UTC time when the fixture was frozen, distinct from the historical issue-state `snapshotAt`; all initial cases use the recoverable corpus-freeze timestamp `2026-08-16T08:57:42Z`.

Answer and scorer metadata live only in each closed `expectations/<caseId>/expected.json`: `schemaVersion`, `caseId`, `issueType`, `triageOutcomeClass`, `execution`, `sizeClass`, `outcomeClass`, `provenance`, `triage`, and `implement`. Implement expectations include the test-excluded `implementLogicLines` measurement. Thus nothing in the producer-readable manifest reveals the expected readiness or implementation outcome; `stage`, `prNumber`, and `capturedAt` remain only because the harness and corpus audit need them to select, orchestrate, and establish the capture boundary.

Some readiness decisions used an operator-authorized story-planner contract posted after the raw issue but before the disposition boundary. For those cases, `decisionContextPath` names a companion input containing the contract's substantive plan, dependencies, sizing, acceptance criteria, and reviewer routing. The companion deliberately excludes disposition recommendations and readiness-label text. Its source timestamp is no later than the issue snapshot's `snapshotAt`, and both precede the recorded verdict boundary. `decisionContextPath` is `null` when no companion input exists.

The issue-snapshot schema remains closed: `issueNumber`, `title`, `body`, `labels`, `state`, `snapshotAt`, and `sourceUrl`. `decisionContextPath` is either `null` or byte-equal to `inputs/<caseId>/decision-context.md`.

The corpus has thin autonomous triage history. Scorer-only `provenance` is `historical-artifact` only when the matching factory-bot/pipeline verdict is preserved. Human/operator dispositions and later readiness outcomes use validator-clean `reconstructed-from-outcome`. Reconstructions are admissible only when provenance is explicit and their frozen issue plus authorized pre-verdict decision context independently supports the recorded verdict.

The N9 input leak check is case-relative: no input file for a case (issue snapshot, decision context, labels, or recorded patch) may contain that case's own scorer-only `triage.expectedReadiness` label, excluding the schema-required `recorded/triage-verdict.json`. A different readiness label appearing in an issue's own text is faithful historical content, not a leak of that case's answer. Recorded verdict artifacts are excluded because their schema necessarily stores the replayed readiness value and they are not inputs to a triage-provider replay.

The `pin` object records the historical repository action pin in force for the case. Null model or prompt/skill versions mean the retained history did not preserve that producer detail; they are never backfilled from a newer run.

## Implement-case size bands

Scorer-only `sizeClass` is a corpus-relative band over the thin-slice factory history represented here, not a claim that a case approaches the factory's 400-line admission ceiling. Logic lines are additions plus deletions with test files excluded, following the repository convention; independently inert data is also excluded where applicable. The exact measurement is stored as `implement.implementLogicLines`.

- `largest-available` means the largest captured implement case in the available thin-history corpus: `issue-058-grant-hardening` at 119 logic lines. It does not mean near the 400-line envelope.
- `small` means every other captured implement case: `issue-009-registry-reconciliation` at 6 logic lines, `issue-026-health-route-dryrun` at 5 logic lines (15 total textual lines including its test), and `issue-151-summary-binding` at 13 logic lines.

## Operator-ratified thin-history deviations

The operator ratified two diversity deviations for this initial recorded-mode corpus:

- **The at-most-four reconstruction cap is waived.** Seven of twelve cases are reconstructed, and every case whose expected label is `ready-for-conventional-implementation` is reconstructed. The paused factory has produced only five genuine bot verdicts total: three `needs-info`, one `wontfix`, one `ready-to-implement`, and zero genuine `ready-for-conventional-implementation` verdicts. Each reconstruction is provenance-marked and input-faithful through authorized pre-boundary context. Enriching the corpus with accrued genuine bot history, including a genuine conventional-readiness anchor, belongs to the deferred live-provider transition as real runs accumulate.
- **The at-least-one near-cap floor relative to the 400-line envelope is waived.** No near-400 implement diff exists in the factory's thin-slice history. The largest available case is #58 at 119 test-excluded logic lines, recorded in `implementLogicLines` and labeled `largest-available`; it is not represented as near the envelope.

For the ratified recorded-mode scope, the corpus is faithful and complete. These waivers concern diversity and anchor richness that only genuine accrued factory history can supply; they do not relax fixture fidelity, producer/scorer isolation, recorded-patch provenance, or scorer expectations.
