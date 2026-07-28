#!/usr/bin/env bash
#
# Safely delete a remote branch, or refuse.
#
# This exists because the prose version of this check was wrong four separate
# times (Codex P1 x4 on PR #156), each time in a way that would have destroyed
# commits while looking correct. Two protected branches had already been swept
# by mistake once. A checklist a careful reader gets wrong four times is the
# wrong medium, so the check is executable instead.
#
# Usage:
#   scripts/safe-delete-remote-branch.sh <branch> [--delete]
#
# Without --delete it only reports. With --delete it deletes ONLY if every
# check passes, using a lease so a concurrent push cannot be clobbered.
#
# What it refuses on, and why each matters:
#
#   1. A narrowed fetch refspec. In a `--single-branch` clone,
#      `git fetch origin --prune` never fetches the branch at all, so any
#      count against it is meaningless. We fetch the exact ref explicitly and
#      fail if that fetch does not produce it.
#   2. Ambiguous revisions. A bare `<branch>` resolves through local refs
#      first (gitrevisions disambiguation), and even `origin/<branch>` loses
#      to a local branch literally named `origin/<branch>`. Only the fully
#      qualified `refs/remotes/origin/<branch>` is unambiguous.
#   3. Unique commits. Any commit on the branch that is not reachable from
#      `refs/remotes/origin/main` means deleting destroys it. Merged-PR
#      evidence is not sufficient on its own, and `git branch --merged` is
#      actively misleading because squash merges break ancestry in both
#      directions.
#   4. Time-of-check/time-of-use. Between the count and the delete, someone
#      can push. The delete is therefore leased to the exact sha that was
#      checked, so a concurrent push makes it fail rather than silently win.
#   5. The protected list. Branches recorded in docs/state/registry.md as
#      never-delete are refused outright, regardless of everything above.
#
set -euo pipefail

REMOTE="origin"
MAIN_REF="refs/remotes/${REMOTE}/main"

# Kept in sync with docs/state/registry.md's "Protected branches" section.
PROTECTED=(
  "feature/12-spec-grounded-publish-90-1-base-sha"
  "feature/12-spec-grounded-publish-90-5-kind-aware-revalidation"
)

die() { echo "REFUSE: $*" >&2; exit 1; }

branch="${1:-}"
[ -n "$branch" ] || die "usage: $0 <branch> [--delete]"
do_delete="${2:-}"

for p in "${PROTECTED[@]}"; do
  [ "$branch" = "$p" ] && die "'$branch' is on the protected list in docs/state/registry.md"
done

# (1) Fetch the exact refs rather than trusting the clone's refspec.
git fetch --no-tags "$REMOTE" \
  "+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}" \
  "+refs/heads/main:refs/remotes/${REMOTE}/main" >/dev/null 2>&1 \
  || die "could not fetch refs/heads/${branch} from ${REMOTE} (does it exist?)"

# (2) Resolve only fully qualified remote-tracking refs.
branch_ref="refs/remotes/${REMOTE}/${branch}"
git show-ref --verify --quiet "$branch_ref" \
  || die "$branch_ref is absent after an explicit fetch"
git show-ref --verify --quiet "$MAIN_REF" \
  || die "$MAIN_REF is absent after an explicit fetch"

sha="$(git rev-parse --verify "${branch_ref}^{commit}")"

# (3) Any commit not reachable from main means deleting destroys it.
unique="$(git rev-list --count "${MAIN_REF}..${branch_ref}")"
echo "branch:  $branch"
echo "sha:     ${sha:0:12}"
echo "unique:  $unique commit(s) not reachable from ${MAIN_REF}"

if [ "$unique" -ne 0 ]; then
  echo
  git log --oneline "${MAIN_REF}..${branch_ref}" | sed 's/^/    /'
  die "$unique commit(s) exist only on '$branch'"
fi

echo "SAFE: every commit on '$branch' is reachable from main"
[ "$do_delete" = "--delete" ] || { echo "(report only; pass --delete to remove it)"; exit 0; }

# (4) Lease the delete to the sha we actually checked.
git push "$REMOTE" --force-with-lease="refs/heads/${branch}:${sha}" \
  --delete "$branch" \
  || die "delete rejected: '$branch' moved since the check (someone pushed). Re-run."
echo "DELETED: $branch at ${sha:0:12}"
