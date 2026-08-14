# Lumenix Widget Library — Contribution and Merge Policy

_Characterisation probe P2 for issue #274 (throwaway, do-not-merge). This is
invented policy prose for a fictional, unrelated project. It is deliberately
policy-shaped — rules, reviewers, blocking conditions, merge gates — but it
contains none of this repository's own governing or review-process text, and
none of its named tools, bots, or mechanisms. Sized to match the P1 and P3
probes so content type is the only variable that moves across the matrix._

## Scope

This document governs how changes land in the Lumenix widget library. It applies
to every pull request against the `trunk` branch, whoever the author is. Where
this document and an individual team's local notes disagree, this document wins,
and the team files a correction rather than quietly following the local copy.

## Branch and change hygiene

- Every change targets `trunk` through a pull request. Direct pushes to `trunk`
  are rejected by the forge and are never made by hand.
- Keep pull requests small. Aim for roughly three hundred changed lines of
  source, excluding generated files and test fixtures. A larger change must
  explain in its description why splitting it would make it harder to review, not
  easier.
- Generated artefacts, snapshots, and vendored dependencies live in their own
  pull request when they can be reviewed on their own. Mixing a large generated
  blob into a logic change hides the logic under the noise.
- The lockfile is committed alongside any dependency change, in the same pull
  request, never after the fact.
- Rebase onto the current `trunk` before requesting review. A stale branch that
  no longer reflects the base is sent back to be refreshed.

## Ownership and routing

Each package names its maintainers in an owners file at the package root. A pull
request that touches a package is routed automatically to that package's owners,
and at least one of them must approve before it merges. A change that spans
several packages collects an owner approval from each of them, so that no single
reviewer is asked to vouch for code they do not maintain. Ownership is a
responsibility rather than a privilege: an owner who is unavailable for a stretch
hands the role to a named deputy rather than letting reviews stall.

## Required checks

A change may not merge until the following checks report green:

- The unit and integration suites pass on every supported runtime.
- The type checker reports no new errors.
- The linter reports no new warnings above the configured budget.
- The bundle-size report shows no regression beyond the agreed threshold for the
  affected package.
- The accessibility audit passes for any component with a visible surface.

Green checks are necessary but never sufficient. A reviewer still reads the
change. A pull request that is mechanically green but unreviewed does not merge.

## Review

- Every pull request needs at least two approvals, and at least one must come
  from a maintainer of the affected package.
- Every review comment left inline must be resolved before merge: either the
  change is made, or the reason for not making it is written in the thread. An
  unresolved thread blocks the merge.
- The author never resolves another reviewer's thread on their own judgement. The
  reviewer who raised it, or a maintainer acting on their behalf, decides when it
  is resolved.
- Reviewers tag each blocking comment clearly, so the author can tell a
  must-fix from a suggestion. Praise, questions, and small nits go in the summary
  rather than inline, to keep the blocking set honest.
- A change that touches a public interface needs a maintainer's explicit sign-off
  on the interface, separate from the general code review, because a shipped
  interface is expensive to take back.

## Security-sensitive changes

Some changes carry more risk than their line count suggests: anything that reads
user input, touches authentication, widens a permission, or alters how the build
itself runs. These are flagged at review time and draw an extra reviewer whose
only job is to look for the ways the change could go wrong. That reviewer works
adversarially, trying to construct a case where the change misbehaves, rather
than confirming that it looks fine. A security-sensitive change does not merge on
a general approval alone; it needs the adversarial pass as well.

## Testing expectations

- New behaviour arrives with tests that assert the behaviour, not merely that the
  code runs. A test that would pass against a broken implementation is not a test.
- Bug fixes arrive with a regression test that fails before the fix and passes
  after it. The description names the test.
- Coverage on changed lines does not fall. If a line genuinely cannot be
  exercised, it is annotated with the reason rather than left silently uncovered
  or waved through by lowering a threshold.
- Test helpers and fixtures are held to the same standard as the source they
  support, because a confusing fixture outlives the change that introduced it.

## Documentation and releases

- A change to a component's public props updates that component's reference page
  in the same pull request, and a new component ships with at least one usage
  example and a note on its accessibility behaviour.
- Releases are cut from `trunk` on a fixed cadence, not on demand, so that every
  release has passed the same gates in the same order. A change that must ship
  out of cadence is backported deliberately, with its own review, rather than by
  cherry-picking around the normal gates.
- The changelog is written for the reader who upgrades, not for the author who
  wrote the change. It names what moved, what broke, and what to do about it.

## Reverting

A change that turns out to be wrong is reverted quickly and without blame. The
revert is itself a pull request, reviewed like any other, and it names the
original change and the reason for pulling it. The follow-up fix comes later, on
its own, once the pressure is off, rather than being rushed in on top of a known
regression.

## Amendments

This policy changes the same way the code does: through a pull request, reviewed
by maintainers, with the reasoning recorded. Nobody edits it in place to unblock
a single change. If a rule here is getting in the way, the fix is to argue the
rule in the open and change it for everyone, not to make a quiet exception for
one merge.
