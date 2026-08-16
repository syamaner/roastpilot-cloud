# Held-out factory regression corpus

This directory is a recorded-mode, held-out evaluation corpus. No case content may ever feed a prompt, skill, few-shot example, or prompt/skill edit. Doing so would turn regression measurement into memorisation.

Corpus updates require an operator-authored decision and a reviewed data-only PR. A non-pass evaluation result never updates, replaces, or relaxes the corpus or its expectations.

Replay producers may read only `manifest.json` and `inputs/**`. Scorers alone may read `expectations/**`; producers must never receive expectation content. Issue snapshots and recorded artifacts are frozen and are never re-fetched during evaluation.

The `pin` object records the historical repository action pin in force for the case. Null model or prompt/skill versions mean the retained history did not preserve that producer detail; they are never backfilled from a newer run.

## Implement-case size bands

`sizeClass` is a corpus-relative band over the thin-slice factory history represented here, not a claim that a case approaches the factory's 400-line admission ceiling. Logic lines are additions plus deletions with test files excluded, following the repository convention; independently inert data is also excluded where applicable.

- `near-cap` means the upper band actually present in this corpus: the largest captured implement case, `issue-058-grant-hardening` at 119 logic lines.
- `small` means every other captured implement case: `issue-009-registry-reconciliation` at 6 logic lines, `issue-026-health-route-dryrun` at 5 logic lines (15 total textual lines including its test), and `issue-151-summary-binding` at 13 logic lines.
