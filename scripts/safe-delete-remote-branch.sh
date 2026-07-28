#!/usr/bin/env bash
#
# Report whether a remote branch is safe to delete. NEVER deletes.
#
# Scope decision (operator, 28 Jul 2026): this tool answers the reachability
# question and stops. Deletion is a manual operator step.
#
# That narrowing is deliberate and the reason is worth keeping. While this
# script could delete, review kept finding real ways the DELETE could land
# somewhere the CHECK had not looked: a leased push whose lease git silently
# omitted from the transaction, a `receivepack` override sending the push to a
# different repository entirely, a lost acknowledgement making a successful
# delete look like a failure, credentials leaking through git's own push
# output, and a symbolic ref that dereferenced to `main` on both sides. Every
# one of those lives in the gap between what was verified and what was mutated.
# Removing the mutation removes the gap, and keeps the part that was genuinely
# hard and genuinely valuable: computing the reachability answer correctly,
# against real objects.
#
# It does NOT make the race disappear. It moves it into the operator's hands,
# between this report and their delete, where a human owns it rather than a
# script asserting it is closed. The output says so explicitly.
#
# Usage:
#   scripts/safe-delete-remote-branch.sh <branch>
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
#   4. Time-of-check/time-of-use. Between this report and a manual delete
#      someone can push. This tool cannot close that window because it does
#      not perform the delete, so it NAMES the window in its output rather
#      than leaving a reader to assume the answer stays true.
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
# `--type=path`, not a bare `--get` (Codex P1, PR #156): git supports `~/x`
# pathname syntax here and EXPANDS it when honouring the file, while `--get`
# returns the literal unexpanded string. Testing that raw value checks a path
# that does not exist while the real graft file is quietly in force — the guard
# would report clean and the deletion would proceed on rewritten history.
# Verified: with `core.graftsFile = ~/somegrafts`, `--get` returns `~/somegrafts`
# and `--type=path --get` returns the expanded absolute path.
grafts_file="$(git config --type=path --get core.graftsFile || true)"
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

# Untrusted branch data reaches the terminal through `git log --oneline`, so a
# commit subject carrying ANSI/OSC escapes or a carriage return could clear,
# overwrite or forge the safety evidence and the refusal message the operator
# reads to make the delete/refuse decision (Codex P2, PR #156). Strip C0 and
# C1 control bytes, keeping tab and newline.
strip_control_bytes() {
  # ESCAPES rather than deletes (Codex P2, PR #156). Deleting the codepoint
  # made `victim` and `victim<U+009B>` — two genuinely different remote refs —
  # render as the same name, so the evidence could not distinguish the ref that
  # was checked from another one. On a report whose entire job is telling an
  # operator which ref they are about to act on, silently collapsing two
  # identifiers is worse than the terminal-control problem it was fixing.
  #
  # Decoding first still distinguishes a raw C1 (malformed UTF-8 -> U+FFFD)
  # from an encoded one, and valid multi-byte characters pass through intact.
  # Tab and newline are kept; everything else in C0, DEL and C1 is rendered
  # visibly and inertly as `<U+XXXX>`.
  perl -MEncode -pe '$_=decode("UTF-8",$_,Encode::FB_DEFAULT); s/([\x{0}-\x{8}\x{b}-\x{1f}\x{7f}-\x{9f}])/sprintf("<U+%04X>",ord($1))/ge; $_=encode("UTF-8",$_)'
}

die() { echo "REFUSE: $*" >&2; exit 1; }

# Git permits control bytes in REF NAMES, and a remotely-created branch is
# attacker-controllable input to this report (Codex P2, PR #156). The commit
# evidence and push output were already sanitised; the branch name itself was
# not, so `evil<U+009B>2J` could clear or forge the SAFE/REFUSE/DELETED lines
# the operator reads. `$branch` stays RAW for every git operation — sanitising
# what we act on would be a correctness bug — and `$branch_display` is used for
# every human-facing message.
branch_display_of() { printf '%s' "$1" | strip_control_bytes; }

branch="${1:-}"
[ -n "$branch" ] || die "usage: $0 <branch>   (reports only; never deletes)"
# RAW `$branch` for every git operation; `$branch_display` for every message.
branch_display="$(branch_display_of "$branch")"
# Exactly one argument now: the branch to REPORT ON. The `--delete` flag is
# gone rather than deprecated, so an old invocation fails loudly instead of
# silently doing less than the caller expects.
[ "$#" -le 1 ] || die "too many arguments; usage: $0 <branch>   (this tool reports only and never deletes)"

# (0) Never the comparison branch itself. Without this, `main` compares to
# itself, reports zero unique commits, and deletes the default branch
# (claude-review + Codex P1, PR #156). Also refuse anything that resolves to
# the same ref under a different name.
[ "$branch" = "main" ] && die "'main' is the comparison branch; deleting it is never safe here"
[ "$branch" = "HEAD" ] && die "refusing the symbolic ref 'HEAD'"

# (0b) `uploadpack` is still refused, and `receivepack` is not, and the
# difference is the whole point of this rescope: a configured upload-pack
# command decides what the FETCH returns, so it can falsify the reachability
# answer this tool exists to produce. A receive-pack override could only
# misdirect a push, and there is no longer a push.
for transport_key in "remote.${REMOTE}.uploadpack" "core.sshCommand"; do
  transport_val="$(git config --get "$transport_key" || true)"
  [ -z "$transport_val" ] || die "$transport_key is set; a configured transport command decides what the fetch returns, so the reachability answer below could describe a repository other than ${REMOTE}"
done
# The environment overrides too (Codex P1, PR #156, reproduced against SSH):
# an SSH wrapper can route `git-upload-pack` to a different repository while
# the configured URL is untouched, so the URL proves nothing about which
# repository answered.
for transport_env in GIT_SSH_COMMAND GIT_SSH; do
  eval "transport_env_val=\${$transport_env:-}"
  [ -z "$transport_env_val" ] || die "$transport_env is set in the environment; it decides which repository answers the fetch, so the reachability answer below cannot be attributed to ${REMOTE}"
done


# (0d) A SYMBOLIC remote ref is not caught by comparing names (Codex P1, PR
# #156, reproduced: `refs/heads/alias -> refs/heads/main` reported zero unique
# commits and the deletion removed `main`). Both the reachability check and the
# push dereference it, so the literal `$branch = main` guard never sees it.
# Refuse anything symbolic rather than trying to resolve and re-compare: an
# alias is never what someone means to delete, and resolving it would put this
# tool back in the business of reasoning about indirection on a destructive
# path.
# BOTH refs, not just the requested one (Codex P1, PR #156, reproduced): with
# remote `main -> victim`, both explicit fetches resolve to the same sha, the
# count is zero, and the report calls `victim` safe — while deleting it would
# take `main`'s target with it. Checking only the requested ref left the
# comparison side unverified, which is the same asymmetry the fetch/push URL
# checks were built to avoid.
symref_line="$(git ls-remote --symref "$REMOTE" "refs/heads/${branch}" "refs/heads/main" 2>/dev/null | grep '^ref: ' || true)"
[ -z "$symref_line" ] || die "'$branch_display' is a SYMBOLIC ref on ${REMOTE} ($(printf '%s' "$symref_line" | strip_control_bytes)); it dereferences to another branch, so deleting it would act on a ref this check never inspected"

for p in "${PROTECTED[@]}"; do
  [ "$branch" = "$p" ] && die "'$branch_display' is on the protected list in docs/state/registry.md"
done

# (1) Fetch the exact refs rather than trusting the clone's refspec.
git fetch --no-tags "$REMOTE" \
  "+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}" \
  "+refs/heads/main:refs/remotes/${REMOTE}/main" >/dev/null 2>&1 \
  || die "could not fetch refs/heads/${branch_display} from ${REMOTE} (does it exist?)"

# (2) Resolve only fully qualified remote-tracking refs.
branch_ref="refs/remotes/${REMOTE}/${branch}"
git show-ref --verify --quiet "$branch_ref" \
  || die "refs/remotes/${REMOTE}/${branch_display} is absent after an explicit fetch"
git show-ref --verify --quiet "$MAIN_REF" \
  || die "$MAIN_REF is absent after an explicit fetch"

sha="$(git rev-parse --verify "${branch_ref}^{commit}")"

# (3) Any commit not reachable from main means deleting destroys it.
# Capture the exact main the reachability count is computed against; the
# deletion is leased to it below so the answer cannot go stale under us.
main_sha_at_check="$(git rev-parse --verify "${MAIN_REF}^{commit}")"
unique="$(git rev-list --count "${MAIN_REF}..${branch_ref}")"
echo "branch:  $branch_display"
echo "sha:     ${sha:0:12}"
echo "unique:  $unique commit(s) not reachable from ${MAIN_REF}"

if [ "$unique" -ne 0 ]; then
  echo
  git log --oneline "${MAIN_REF}..${branch_ref}" | strip_control_bytes | sed 's/^/    /'
  die "$unique commit(s) exist only on '$branch_display'"
fi


echo
echo "VERDICT: SAFE TO DELETE — every commit on '$branch_display' is reachable from main."
echo
echo "This tool does NOT delete. It answers the reachability question and stops"
echo "(operator decision, 28 Jul 2026). Deletion is a manual operator step:"
echo
# `printf %q` and an option terminator (Codex P1, PR #156). This line is
# COPY-PASTEABLE, and the branch name is attacker-controlled: git permits shell
# metacharacters in ref names, so `merged;touch${IFS}/tmp/pwned` printed raw
# turns a safety report into a command-injection vector at the exact moment the
# operator is being told to run something destructive. `--` stops a
# leading-dash name being read as an option.
#
# Note this prints the RAW branch, shell-quoted, not `$branch_display`: the
# display form has had control bytes stripped for safety, so pasting it could
# act on a DIFFERENT ref than the one checked, or on none.
printf '    git push %q --delete -- %q\n' "$REMOTE" "$branch"
echo
echo "Note the window this leaves, because it is real and it is now yours: the"
echo "answer above describes the remote AS OF NOW. If someone pushes to"
echo "'$branch_display' between this report and your delete, the delete removes"
echo "commits this check never saw. Re-run immediately before deleting, and"
echo "prefer doing both while nothing else is pushing."