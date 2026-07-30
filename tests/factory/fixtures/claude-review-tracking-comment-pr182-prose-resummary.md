**Claude finished @syamaner's task in 1m 37s** —— [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/30547564749)

---
### Review summary

Re-reviewed at the current head (`7c69ce6`), which adds one commit since the automatic review: folding the "workflow run expression corpus" → "workflow sink expression corpus" string nit flagged inline earlier.

**Prior nit — confirmed fixed.** Commit `7c69ce6` updates both the `validateWorkflowSinkExpressionCorpus` empty-corpus return (line 141) and its matching assertion (line 370) to "workflow sink expression corpus must not be empty". Verified the diff is exactly those two lines, nothing else touched. The remaining "run expression" strings in test titles (`rejects unrecognised run expression`, `allows reviewed run expression`, `catches a composite action run expression`) were left as-is, correctly — those tests genuinely target `run:` sinks.

**Re-traced the guard logic on this diff:**
- `SINK_KEYS.has(key.toLowerCase()) && typeof child === "string"` (line 74) is exact Set-membership on the lowercased key — no substring/prefix risk against non-sink keys like `runs:`/`run-name:`.
- The unconditional recursion at line 85 (`findUnrecognisedSinkExpressions(child, childLocation)`) runs regardless of whether the sink arm matched, and terminates cleanly on a string child (`asMapping` returns `undefined` for a string, short-circuiting to `[]`), so there's no double-count and no risk of the sink-arm and the general recursion diverging.
- `script` is matched unscoped (not gated on parent `with`), which is what T7 pins — confirms the fail-closed direction reasoning in the doc comment (scoping to `with` would miss `script` reached through an unenumerated shape).
- Ran `grep -rnE '(shell|script)\s*:' .github/` myself: two `shell: bash` keys, zero `script:` — matches the PR's live-corpus claim exactly, so this extension can't flag anything in the current manifest set.
- Ran `grep` for the pre-rename identifiers (`findUnrecognisedRunExpressions`, `validateWorkflowRunExpressions`, `RUN_EXPRESSION`, `ALLOWED_RUN_EXPRESSIONS`) across the repo: zero hits outside this file — the stated single-file rename blast radius holds.
- Case-insensitive matching (`.toLowerCase()` on the check only, key casing preserved in the reported location string) is consistent with T11/T12 and the cited `workflow-pin-audit-logic.mts` precedent.

I wasn't able to execute `npm run test`/`typecheck` in this sandbox (Bash requires approval I don't have here), so this is a static trace, not a live run — consistent with the PR's own reported `2762 passed`, in-file `45/45`, and the prior `factory-security-reviewer`/`qa` passes.

**No new issues found.** No correctness, fail-open, or false-negative concerns on this head. The routing (conventional/interactive, mandatory `factory-security-reviewer` pass already recorded) matches what this one-file `tests/factory/**` diff needs.
