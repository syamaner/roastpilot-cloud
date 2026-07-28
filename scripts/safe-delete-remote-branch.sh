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

# (0) Never the comparison branch itself. Without this, `main` compares to
# itself, reports zero unique commits, and deletes the default branch
# (claude-review + Codex P1, PR #156). Also refuse anything that resolves to
# the same ref under a different name.
[ "$branch" = "main" ] && die "'main' is the comparison branch; deleting it is never safe here"
[ "$branch" = "HEAD" ] && die "refusing the symbolic ref 'HEAD'"

# (0b) The safety check must bind to the ref the DELETE will actually hit.
# `git remote set-url --push` is an explicitly supported configuration in
# which fetch and push target different URLs, so verifying one and deleting
# on the other proves nothing (Codex P1, PR #156).
# `--all`, not the default: a remote may configure MULTIPLE `pushurl` entries,
# and `git remote get-url --push` returns only the first, so a matching first
# entry would hide a divergent second one (Codex P1, PR #156). Every push URL
# must match the fetch URL, or the delete could land somewhere the check never
# inspected.
#
# URLs are REDACTED before being printed: a remote URL may carry inline
# credentials (`https://user:token@host/...`), and this refusal path would
# otherwise print them straight into a terminal or CI log (Codex P1, PR #156).
redact_url() { printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1<redacted>@#'; }

fetch_url="$(git remote get-url "$REMOTE")"
while IFS= read -r push_url; do
  [ -n "$push_url" ] || continue
  [ "$fetch_url" = "$push_url" ] || die "\
${REMOTE} fetches from '$(redact_url "$fetch_url")' but has a push URL '$(redact_url "$push_url")'.
The safety check would inspect one remote and delete on another. Refusing."
done <<EOF
$(git remote get-url --push --all "$REMOTE")
EOF

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

# (4) The reachability decision also depends on the main sha we fetched, and
# the lease can only protect the ref being deleted (Codex P2, PR #156). So
# re-fetch main immediately before deleting and refuse if it moved: a main
# that advanced or was rewritten under us invalidates the count, even though
# the branch itself is unchanged.
main_sha_at_check="$(git rev-parse --verify "${MAIN_REF}^{commit}")"
git fetch --no-tags "$REMOTE" "+refs/heads/main:refs/remotes/${REMOTE}/main" >/dev/null 2>&1 \
  || die "could not re-verify main before deleting"
main_sha_now="$(git rev-parse --verify "${MAIN_REF}^{commit}")"
# A truly atomic pin across fetch-then-push is not available in git, so bound
# the hazard precisely instead (Codex P1, PR #156). Reachability can only ever
# GROW when main fast-forwards, so an advanced main cannot turn a safe answer
# into an unsafe one. The dangerous case is main being REWOUND or rewritten,
# which can strand commits that were reachable when we counted. Accept the
# former, refuse the latter.
if [ "$main_sha_at_check" != "$main_sha_now" ]; then
  git merge-base --is-ancestor "$main_sha_at_check" "$main_sha_now" 2>/dev/null \
    || die "main was rewritten (${main_sha_at_check:0:12} is not an ancestor of ${main_sha_now:0:12}); the reachability result may be stale. Re-run."
  echo "note: main fast-forwarded ${main_sha_at_check:0:12} -> ${main_sha_now:0:12}; reachability can only have grown, continuing"
fi

# (5) Lease the delete to the branch sha we actually checked, so a concurrent
# push to the branch fails the delete rather than being clobbered.
git push "$REMOTE" --force-with-lease="refs/heads/${branch}:${sha}" \
  --delete "$branch" \
  || die "delete rejected: '$branch' moved since the check (someone pushed). Re-run."
echo "DELETED: $branch at ${sha:0:12}"
