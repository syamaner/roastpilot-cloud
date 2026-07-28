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

# Replacement refs rewrite history for every traversal, so a local
# `refs/replace/*` entry would make `git rev-list` answer the reachability
# question about a substituted graph rather than the real one (Codex P1, PR
# #156). A destructive decision must be taken against real objects.
export GIT_NO_REPLACE_OBJECTS=1

# Grafts are a SEPARATE mechanism and the env var above does not disable them
# (Codex P1, PR #156, reproduced: grafting main onto a unique branch tip made
# the script report `unique: 0` and delete the branch). They are deprecated but
# still honoured, so refuse outright rather than try to reason around them.
# `core.graftsFile` can relocate the file, so ask git where it is rather than
# assuming the default path.
grafts_file="$(git config --get core.graftsFile || true)"
[ -n "$grafts_file" ] || grafts_file="$(git rev-parse --git-path info/grafts)"
[ -e "$grafts_file" ] && { echo "REFUSE: a graft file exists at '$grafts_file'; it rewrites history for reachability and cannot be disabled the way replacement refs can. Remove it before running this." >&2; exit 1; }

REMOTE="origin"
MAIN_REF="refs/remotes/${REMOTE}/main"

# Kept in sync with docs/state/registry.md's "Protected branches" section.
#
# Two copies of a destructive safeguard can drift, and the drift is silent and
# one-directional: a branch added to the registry but not here is reported SAFE
# and deleted, which is the exact accident this list exists to prevent and which
# has already happened once (Codex P2, PR #156).
#
# The list stays literal here rather than being parsed out of the registry at
# runtime, because this script must refuse correctly even when run from a
# different cwd, a partial checkout, or a clone where that file is absent or
# malformed — a safeguard that depends on parsing prose can fail open. Instead
# the drift itself is made a test failure: `safe-delete-remote-branch.test.ts`
# parses the registry table and asserts the two agree exactly, so adding a
# branch to the registry alone reddens CI rather than silently disarming this.
PROTECTED=(
  "feature/12-spec-grounded-publish-90-1-base-sha"
  "feature/12-spec-grounded-publish-90-5-kind-aware-revalidation"
)

die() { echo "REFUSE: $*" >&2; exit 1; }

branch="${1:-}"
[ -n "$branch" ] || die "usage: $0 <branch> [--delete]"
do_delete="${2:-}"
# Only two arguments are meaningful, and anything past the second was being
# silently ignored (Codex P2, PR #156). On a destructive tool that is a real
# hazard: a typo'd or reordered invocation could look accepted while the flag
# the operator intended went unread.
[ "$#" -le 2 ] || die "too many arguments; usage: $0 <branch> [--delete]"
case "${do_delete:-}" in ""|--delete) ;; *) die "unrecognised second argument '$do_delete'; only --delete is accepted" ;; esac

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
#
# This redaction took three rounds, and the first two were the same mistake
# twice: v1 handled only `scheme://userinfo@host`; v2 added an ALLOWLIST of
# credential parameter names (`access_token`, `token`, `secret`, ...), which
# Codex then broke again with `client_secret` — the name is anchored to `[?&]`,
# so a compound key simply misses the list (Codex P1, PR #156, round 3).
#
# Enumerating credential-bearing key names cannot be finished: every new name
# is a fresh leak, and the failure is silent and unrecoverable, because a token
# printed into a CI log is disclosed before anyone notices the list was short.
# So this no longer enumerates. EVERY query-parameter VALUE is redacted
# regardless of its key, which fails closed by construction. Key names survive
# for diagnosis, and host/path — the only part that identifies which remote
# mismatched — is untouched.
redact_url() {
  printf '%s' "$1" \
    | sed -E 's#(://)[^/@]*@#\1<redacted>@#' \
    | sed -E 's#\?[^#[:space:]]*#?<redacted>#g'
}

fetch_url="$(git remote get-url "$REMOTE")"
seen_push_urls=""
while IFS= read -r push_url; do
  [ -n "$push_url" ] || continue
  # A repeated push URL means the delete would be attempted against the same
  # target more than once (Codex P2, PR #156). Refuse before mutating anything
  # rather than discovering it half-way through.
  case "$seen_push_urls" in
    *"|${push_url}|"*) die "'${REMOTE}' lists the push URL '$(redact_url "$push_url")' more than once; refusing to delete against a duplicated target" ;;
  esac
  seen_push_urls="${seen_push_urls}|${push_url}|"
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
# Capture the exact main the reachability count is computed against; the
# deletion is leased to it below so the answer cannot go stale under us.
main_sha_at_check="$(git rev-parse --verify "${MAIN_REF}^{commit}")"
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

# (4) Close the race properly, with ONE atomic leased push (Codex P1, PR
# #156). An earlier version of this script re-fetched main, compared it, and
# claimed git offered no atomic fetch-then-push so the hazard could only be
# bounded. That was wrong. `git push --atomic` carries several refspecs and
# several `--force-with-lease` options, and either all succeed or none do, so
# the deletion can be leased to BOTH the branch sha and the main sha that the
# reachability count was actually computed against.
#
# WHAT THIS DOES AND DOES NOT CLOSE (corrected, Codex P1 PR #156, after I
# claimed the race was closed rather than narrowed — twice, in opposite
# directions, so the evidence is recorded here rather than the conclusion).
#
# Verified with a pre-receive hook on a real remote: when main still equals
# `main_sha_at_check` at the moment git reads the remote advertisement, git
# treats that refspec as ALREADY UP TO DATE and omits it from the transaction
# entirely. The hook sees only the branch deletion. So on the ordinary path
# main's lease does NOT participate, and cannot detect a rewrite that lands
# between the advertisement and the deletion.
#
# What still holds: the BRANCH lease does participate, because the branch is
# being deleted, so a concurrent push to the branch is caught. And when main
# HAS already moved by advertisement time, the refspec is a rewind, so the
# push is rejected and nothing is deleted.
#
# The residual window is therefore narrow and specific: a force-rewrite of main
# landing after the advertisement but before the deletion, which would have to
# make the branch's commits unreachable. On this repo main is protected against
# exactly that. This is a documented residual, NOT a closed race — the earlier
# claim that `--atomic` plus two leases closed it was wrong, and a reader acting
# on that claim would over-trust this tool.
#
# The main refspec is a no-op update of main to the value we already checked.
# Verified empirically both ways, by a real-git regression test that rewrites
# main from inside the script's own run (a `git` shim that mutates the remote
# on the push call, so the rewrite lands after the fetch and reachability
# count): with main unchanged the delete succeeds, and with main rewritten
# mid-run the whole push is rejected and the branch survives.
#
# Which part does that work is worth stating exactly, since an earlier comment
# here overclaimed. Deleting each piece and re-running the test shows the
# REFSPEC is load-bearing: without it the branch is deleted despite main having
# moved. The main LEASE is defence in depth — pushing the checked main sha back
# over a moved main is a rewind, so git rejects it as non-fast-forward with or
# without the lease. The lease would carry the refusal if this refspec were
# ever forced, which is why it stays.
#
# Any movement of main fails this push, including a benign fast-forward. That
# is deliberate for a destructive tool: the cost is one re-run, and the
# alternative is reasoning about which movements are safe while a delete is in
# flight.
# git prints the remote URL in its own push output, on success ("To <url>")
# and on failure alike, and that output does NOT go through redact_url. When
# fetch and push URLs match, this script proceeds all the way to here, so a
# credential carried in the URL leaks through git's output even though every
# message this script writes itself is redacted (Codex P1, PR #156).
# Confirmed against real git rather than assumed: a push to
# `https://host/x.git?access_token=CANARY` prints the token verbatim.
# So the push output is captured and redacted before anything is shown.
push_status=0
push_output="$(git push --atomic --no-follow-tags "$REMOTE" \
  --force-with-lease="refs/heads/${branch}:${sha}" \
  --force-with-lease="refs/heads/main:${main_sha_at_check}" \
  ":refs/heads/${branch}" \
  "${main_sha_at_check}:refs/heads/main" 2>&1)" || push_status=$?
if [ -n "$push_output" ]; then
  { redact_url "$push_output"; echo; } >&2
fi
if [ "$push_status" -ne 0 ]; then
  die "atomic delete rejected: '$branch' or 'main' moved since the check. Nothing was deleted. Re-run."
fi
echo "DELETED: $branch at ${sha:0:12} (leased against main ${main_sha_at_check:0:12})"
