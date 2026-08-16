# Held-out factory regression corpus

This directory is a recorded-mode, held-out evaluation corpus. No case content may ever feed a prompt, skill, few-shot example, or prompt/skill edit. Doing so would turn regression measurement into memorisation.

Corpus updates require an operator-authored decision and a reviewed data-only PR. A non-pass evaluation result never updates, replaces, or relaxes the corpus or its expectations.

Replay producers may read only `manifest.json` and `inputs/**`. Scorers alone may read `expectations/**`; producers must never receive expectation content. Issue snapshots and recorded artifacts are frozen and are never re-fetched during evaluation.

The `pin` object records the historical repository action pin in force for the case. Null model or prompt/skill versions mean the retained history did not preserve that producer detail; they are never backfilled from a newer run.
