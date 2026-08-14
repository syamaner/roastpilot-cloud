## PR Merge Policy

Full policy: `factory.md` §9, identical to the agent repo's, no factory
exception. The load-bearing points:

- **Green CI is necessary but not sufficient.** Read every review comment
  before claiming mergeable — `gh pr checks` alone is not a merge signal.
- **Every inline review thread must be resolved** (branch protection:
  `required_conversation_resolution`). Fix it, or state in-thread why it's
  not being actioned.
- **Codex is advisory-but-triaged, not a required check.** Codex reviews
  automatically the moment a PR is opened ready-for-review, or the moment a
  draft is marked ready; it does not trigger on opening a draft (confirmed
  against PR #150, 27 Jul 2026, and part of a wider pattern, see D103 below:
  the whole review roster, not just Codex, is suppressed while a PR sits in
  draft and fires together at ready). A manual `@codex review` comment is
  not needed for that first review; it remains the way to re-trigger a
  review on a new head after the automatic one, once, on the final commit,
  never on intermediate pushes. A 👀 reaction means the review is **in
  progress, keep waiting** (bounded ~30 min from the 👀). If that bound expires
  without a verdict, escalate and investigate the stalled review rather than
  posting `@codex review` again on the same head; the roughly 30-minute
  manual-trigger clause applies only when no signal appeared, because a duplicate
  trigger on an engaged head withdraws a pending 👍 and burns a round. It does
  **not** clear the merge by itself. A CLEAN verdict, **in either channel, and ONLY
  when authored by the Codex bot identity (`chatgpt-codex-connector[bot]`)**,
  is either a **👍 reaction (after the bot's OWN 👀 — that preceding 👀 must itself be
  bot-authored, since on a public repo a stranger can leave one and a rule that
  accepts any 👀 lets a third party supply half the verdict; Codex P2, #155)** OR a **top-level "Codex Review: Didn't
  find any major issues" comment carrying a `Reviewed commit: <sha>` line** whose
  sha matches the PR head. The repo is public, so anyone can add a 👍 reaction OR
  post a comment copying that title plus the visible head sha; **bot-authorship is
  required on BOTH channels: a reaction or comment content alone is spoofable.**
  A watcher MUST verify the reaction's / comment's author is the Codex bot (the
  reactions API returns each reaction's `user.login`); one polling only reviews +
  reactions is also blind to the comment channel entirely. A **posted
  `pull_request_review` with inline threads** = findings.
  The signal must correspond to the current head AND postdate **the event that
  started the automatic review for this PR's shape**, which is not the same
  event in both cases (Codex P1, #155):
  - a PR **created ready** (every factory-authored PR, #62) emits `opened` and
    NEVER emits `ready_for_review`, so `opened` is its boundary. Requiring a
    `ready_for_review` timestamp here would be unsatisfiable and would block
    every untouched factory PR permanently. EXCEPTION (Codex P2, #155): a PR
    the publisher had to open on the **fallback** path, with `GITHUB_TOKEN`
    because App minting failed, gets NO downstream WORKFLOW triggers
    (factory.md §13), so CI, CodeQL and Claude Code Review genuinely do not
    run. **Codex is not governed by that rule** (Codex P2, #155, corrected):
    the connector is an installed GitHub App receiving webhooks, not an
    Actions workflow, so whether it auto-reviews a fallback PR is UNVERIFIED
    in both directions — and the publisher's own fallback notice quotes the
    trigger phrase, which the connector has been observed matching inside
    posted comment bodies (roastpilot-agent#682, 28 Jul 2026), so that notice
    may itself have started a review. So LOOK FIRST rather than assuming
    either way: if a 👀 or a review is already on the head, you are in the
    wait; only if nothing has appeared within the timeout below does the
    operator post `@codex review` themselves. This is the same look-first
    guidance the generated notices carry, and it must stay the same — an
    operator following a policy that says "nothing else will start it" posts
    the duplicate the once-per-head rule forbids. **The ACCEPTANCE criterion is unchanged**
    (Codex, #155): "no automatic verdict to wait for" does not mean no wait.
    The manually triggered review must still come back CLEAN on an accepted
    channel, and a review carrying findings is not clean even when posted as
    a top-level comment with no inline threads, so nothing blocks merge
    mechanically and the operator is the only check. The publisher's fallback summary now
    names that trigger explicitly (Codex P2, #155: it previously asked only
    for "a manual review pass", so an operator could complete it without
    ever starting the diverse lens);
  - a **draft marked ready** emits `ready_for_review`, and that is its
    boundary;
  - after any later push, the boundary becomes the fresh single re-trigger on
    that new final commit.

  **If the automatic review never arrives**, post `@codex review` once on the
  unchanged head after roughly 30 minutes from the boundary event, and treat
  that as the trigger from then on. This is NOT the re-litigation the
  once-on-final rule forbids: that rule targets re-triggering across pushes,
  and this is a first review that did not start. The 👀 in-progress bound
  below only exists once a review has begun, so without this clause the
  automatic path has no timeout at all and the documented state is "wait
  indefinitely" (Codex, #155). Worth knowing when you rely on it: the
  automatic trigger has been OBSERVED on human-authored PRs (#150, #155,
  #156, agent #682) and has NOT yet been observed on a bot-authored factory
  PR. Both sibling Claude review lenses now admit the confirmed publisher
  identity, so treat Codex's arrival as expected rather than done.

  Head-match alone is NOT enough, and that is a real hole rather than a
  theoretical one (Codex P1 on the agent repo's copy, #682): a manually
  requested review on the DRAFT posts findings against the very same sha, so
  if nothing needed changing before marking ready, a head-match-only rule
  would let that pre-ready verdict satisfy the wait while the automatic review
  the ready transition just started is still in flight. A comment or review
  naming an earlier commit sha does not satisfy the wait either, and a 👍
  reaction carries no sha, so it is valid only while the head stays unchanged
  since it was left. Do not arm auto-merge on green CI alone.

  **What the draft phase is and is not.** The AUTOMATIC trigger does not fire
  on a draft, so a draft cannot converge the review roster on its own. But a
  manual `@codex review` on a draft is NOT inert (Codex P1, #155; D105): it
  runs and posts findings against the draft head, and those findings are real
  and worth folding. What it cannot do is complete the clean-verdict flow, so
  a draft waiting for a clean signal waits forever. Both facts hold because
  they describe different mechanisms. The once-on-final discipline governs the
  single automatic trigger at ready; only a later push needs a manual
  re-trigger, once, on its new final commit.
- **`pr-triage` adjudicates independently of the author.** Under the factory,
  the author is always an agent; it never self-triages its own PR's review
  comments (D23). The lead (or the `pr-triage` sub-agent) decides what counts
  as resolved.
- **Coverage regressions must be sorted, not waved through** — add the test
  or tag a genuinely unreachable line, never lower a threshold.

