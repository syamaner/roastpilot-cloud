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
  # Two passes, and this time the first one is UTF-8-AWARE, which is what both
  # earlier attempts got wrong (Codex P2, PR #156, x3).
  #
  #   v1 used `\xNN` escapes that BSD sed silently ignores — stripped nothing.
  #   v2 handled only the encoded form, so a raw byte passed straight through.
  #   v3 escaped raw bytes byte-wise, but split valid sequences: `c2 9b` became
  #      an orphaned `c2` (-> U+FFFD) plus `<U+009B>`.
  #   v4 reverted to decode-only, which loses the raw case again — and the
  #      reviewer then REPRODUCED that case on Git 2.43, where a ref really can
  #      hold `\x9b`. I had wrongly concluded it was unconstructable because
  #      macOS refuses such a ref name at the filesystem layer. Platform-
  #      specific absence is not absence.
  #
  # So: pass 1 matches whole VALID UTF-8 sequences and lets them through
  # untouched, escaping only bytes that are not part of one. Pass 2 then escapes
  # control CODEPOINTS in the now-valid stream. Raw and encoded C1 end up as the
  # same visible marker without either being corrupted, and two refs differing
  # by such a byte cannot render alike.
  perl -pe 'BEGIN{binmode STDIN;binmode STDOUT}
      s{( [\xc2-\xdf][\x80-\xbf]
         | \xe0[\xa0-\xbf][\x80-\xbf]
         | [\xe1-\xec][\x80-\xbf]{2}
         | \xed[\x80-\x9f][\x80-\xbf]
         | [\xee-\xef][\x80-\xbf]{2}
         | \xf0[\x90-\xbf][\x80-\xbf]{2}
         | [\xf1-\xf3][\x80-\xbf]{3}
         | \xf4[\x80-\x8f][\x80-\xbf]{2}
         | [\x09\x0a\x20-\x7e] )
       |([\x00-\xff])}
       {defined $1 ? $1 : sprintf("<U+%04X>", ord($2))}gex' \
    | perl -MEncode -pe '$_=decode("UTF-8",$_,Encode::FB_DEFAULT); s/([\x{0}-\x{8}\x{b}-\x{1f}\x{7f}-\x{9f}])/sprintf("<U+%04X>",ord($1))/ge; $_=encode("UTF-8",$_)'
}

# `printf`, not `echo` (Codex P2, PR #156). With `xpg_echo` inherited — an
# exported `BASHOPTS` is enough — `echo` INTERPRETS backslash escapes, so a
# path or ref containing the printable text `\033[2J` is turned back into a
# raw terminal escape by the very call that reports it. The sanitiser is
# correct to leave printable text alone; the bug is re-interpreting it on the
# way out. Every refusal flows through here, so this is the one place to fix
# it — and `%s` also stops a leading `-` in the message being read as a flag.
die() { printf 'REFUSE: %s\n' "$*" >&2; exit 1; }

# Git permits control bytes in REF NAMES, and a remotely-created branch is
# attacker-controllable input to this report (Codex P2, PR #156). The commit
# evidence and push output were already sanitised; the branch name itself was
# not, so `evil<U+009B>2J` could clear or forge the SAFE/REFUSE/DELETED lines
# the operator reads. `$branch` stays RAW for every git operation — sanitising
# what we act on would be a correctness bug — and `$branch_display` is used for
# every human-facing message.
branch_display_of() { printf '%s' "$1" | strip_control_bytes; }

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
# The PATH is attacker-influenced too (Codex P2, PR #156): a graft filename or
# repository path containing ESC/CR writes those bytes straight to the terminal
# from inside the refusal itself.
[ -e "$grafts_file" ] && { printf 'REFUSE: a graft file exists at %s; it rewrites history for reachability and cannot be disabled the way replacement refs can. Remove it before running this.\n' "'$(printf '%s' "$grafts_file" | strip_control_bytes)'" >&2; exit 1; }

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
# (0b-ii) The report ENDS with a copy-pasteable `git push ${REMOTE} --delete`,
# so a push URL diverging from the fetch URL means the advice acts on a
# repository this check never inspected (Codex P1, PR #156).
#
# I removed this check during the report-only rescope, reasoning that there is
# no push. That was wrong in an instructive way: there is no push BY THIS
# SCRIPT, but the script now tells a human to perform one, so the binding
# between "what was checked" and "what gets mutated" still has to hold — it just
# runs through the operator instead of through git. Removing a mutation does not
# remove a guard whose premise the removal reintroduced in another form.
while IFS= read -r push_url_check; do
  [ -n "$push_url_check" ] || continue
  [ "$push_url_check" = "$(git remote get-url "$REMOTE")" ] || die "${REMOTE} fetches from one URL and pushes to another; this report inspects the FETCH side, and the deletion command it prints would act on the PUSH side, which was never checked"
done <<EOF
$(git remote get-url --push --all "$REMOTE")
EOF

# `receivepack` is back (Codex P1, PR #156). I dropped it in the report-only
# rescope reasoning "there is no push", then restored the push-URL check one
# round later for the exact reason that invalidates the drop — the success path
# PRINTS a `git push` command — and did not restore its sibling. Reproduced by
# the reviewer: origin fetching from A with a receive-pack wrapper targeting B,
# the report says SAFE about A, the suggested command deletes from B.
for transport_key in "remote.${REMOTE}.uploadpack" "remote.${REMOTE}.receivepack" "core.sshCommand"; do
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
# Two defences, because the first one cannot be made reliable.
#
# `--symref` is asked for over protocol v2, which is what exposes ARBITRARY
# branch symrefs; v0/v1 advertise only HEAD's (Codex P1, PR #156, reproduced —
# with protocol.version=0 an `alias -> main` went unseen, the report said SAFE,
# and the suggested command deleted `main`). I first tried to detect the
# degraded case by checking that HEAD came back as a `ref:` line, and verified
# that this DOES NOT WORK: v0 advertises HEAD's symref perfectly well, so the
# probe passes while arbitrary symrefs stay hidden. A negotiated-down server
# therefore cannot be detected this way, and I am not going to pretend it can.
#
# So the load-bearing guard is the second one, and it needs no protocol support
# at all: an alias to main resolves to EXACTLY main's sha. When the branch and
# main are sha-identical we cannot tell an alias from a coincidence without
# symref data we may not have, so we refuse. The cost is refusing a genuine
# branch that happens to sit exactly on main — which has nothing unique to lose
# and can be deleted by hand — and the benefit is that the alias case cannot
# reach a SAFE verdict regardless of protocol.
symref_line="$(git -c protocol.version=2 ls-remote --symref "$REMOTE" "refs/heads/${branch}" "refs/heads/main" 2>/dev/null | grep '^ref: ' || true)"
[ -z "$symref_line" ] || die "'$branch_display' is a SYMBOLIC ref on ${REMOTE} ($(printf '%s' "$symref_line" | strip_control_bytes)); it dereferences to another branch, so deleting it would act on a ref this check never inspected"

for p in "${PROTECTED[@]}"; do
  [ "$branch" = "$p" ] && die "'$branch_display' is on the protected list in docs/state/registry.md"
done

# (0e) The LOCAL tracking refs can be symbolic too (Codex P1, PR #156). If
# `refs/remotes/origin/main` is symbolic to the branch's tracking ref, the fetch
# refspecs below write THROUGH that indirection: the second refspec overwrites
# the branch's tracking ref with main, so `rev-list` compares main to itself and
# reports zero unique commits on a branch that is genuinely ahead.
#
# This is the same defect as the remote-side symbolic check added earlier, on
# the other side of the fetch — I verified the refs the REMOTE hands us and not
# the refs we write them into.
for local_ref in "refs/remotes/${REMOTE}/${branch}" "$MAIN_REF"; do
  local_sym="$(git symbolic-ref -q "$local_ref" || true)"
  [ -z "$local_sym" ] || die "local tracking ref $(printf '%s' "$local_ref" | strip_control_bytes) is SYMBOLIC (-> $(printf '%s' "$local_sym" | strip_control_bytes)); the fetch would write through it and the reachability count would describe a different ref"
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
# A shallow clone's boundary is not removed by an explicit fetch, so the
# traversal silently stops at it and the count and log both under-report
# (Codex P2, PR #156, reproduced: three unique commits reported as two, with the
# oldest missing from the evidence). The refusal direction is safe, but this
# report is read as COMPLETE evidence for deciding whether content is
# superseded, so incomplete evidence is the defect.
[ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo true)" = "false" ] \
  || die "this is a SHALLOW repository; the reachability traversal would stop at the shallow boundary and silently under-report unique commits. Run \`git fetch --unshallow\` first"

# The protocol-independent half of the symbolic-ref defence (see above): an
# alias to main is sha-identical to main, and no reachability count can tell
# the two apart.
[ "$sha" != "$(git rev-parse --verify "${MAIN_REF}^{commit}")" ] \
  || die "'$branch_display' resolves to exactly the same commit as main. That is what an alias to main looks like, and this check cannot distinguish an alias from a coincidence without symref data the remote may not advertise. Refusing: deleting an alias would take main's target with it"

unique="$(git rev-list --count "${MAIN_REF}..${branch_ref}")"
printf 'branch:  %s\n' "$branch_display"
printf "sha:     %s\n" "${sha:0:12}"
printf 'unique:  %s commit(s) not reachable from %s\n' "$unique" "${MAIN_REF}"

if [ "$unique" -ne 0 ]; then
  echo
  git log --oneline "${MAIN_REF}..${branch_ref}" | strip_control_bytes | sed 's/^/    /'
  die "$unique commit(s) exist only on '$branch_display'"
fi


echo
printf "VERDICT: SAFE TO DELETE — every commit on '%s' is reachable from main.\n" "$branch_display"
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
printf "'%s' between this report and your delete, the delete removes\n" "$branch_display"
echo "commits this check never saw. Re-run immediately before deleting, and"
echo "prefer doing both while nothing else is pushing."