/**
 * Pure logic for the privileged `publish` job's BLOCKER inline comments
 * (slice 3b-iii-c, F1-S9, issue #12) — the novel mechanism this slice was
 * split out for (team-lead's scope split, 3b-iii kickoff): turning a
 * {@link JoinedCriterionResult} blocker or an {@link
 * UnreviewedClosingIssueResult} into a real, resolvable GitHub inline
 * review comment requires a `path` + `line` on the PR's diff to anchor to
 * — data neither the read-only review agent (never given a location field
 * to fill in; `spec-grounding-verdict-schema.mts` has no such field) nor
 * the trusted spine (criteria are text-level, not diff-position-level)
 * can supply. Nothing here calls the network; the network-facing
 * entrypoint (3b-iii-d+e, not yet built) fetches the diff, calls these
 * functions, and issues the resulting API calls.
 *
 * BOUNDING THE NUMBER OF INLINE COMMENTS (PR #82 round 2 review, FOLD 2,
 * BLOCKER — API-abuse via a crafted PR body): a public PR body can name
 * thousands of `Closes #N` references (`parseLinkedIssueReferences`,
 * `spec-grounding-logic.mts`, has no cap on how many DISTINCT issue
 * numbers it parses — only `MAX_LINKED_ISSUES` (20) caps how many get
 * FETCHED). Before this round, every entry in `unreviewedClosingIssues`
 * became its OWN inline comment — a crafted PR body naming thousands of
 * closing issues would make {@link planBlockerInlineComments} attempt
 * thousands of GitHub write API calls. Fixed by capping individual
 * comments at {@link MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS} and
 * aggregating the remainder into ONE length-bounded comment (see
 * {@link buildAggregatedUnreviewedClosingIssuesCommentBody}) — the same
 * "bound the output" family as `publish-spec-grounding-verdict-logic.mts`'s
 * own `MAX_FINDINGS_LIST_LENGTH` (round 1's size fix), applied here to
 * COUNT rather than character length.
 *
 * THE ANCHOR PROBLEM AND ITS RESOLUTION: a blocker is a whole-criterion or
 * whole-issue finding, not a line-level defect location, so there is no
 * principled "correct" line to anchor it to. This module picks a
 * DETERMINISTIC anchor — the first added (`+`) line of the first file in
 * the diff that has one — and every blocker inline comment it builds
 * EXPLICITLY SAYS SO (team-lead's "self-describing anchor comment"
 * hardening): the comment never implies the anchor is the actual site of
 * the gap. When the diff has no addable line at all (an empty diff, or a
 * diff that only deletes content — {@link selectDeterministicBlockerAnchor}
 * returns `null`), there is nowhere to post an inline comment at all;
 * {@link planBlockerInlineComments} surfaces this as `anchorFallbackNeeded:
 * true` rather than silently dropping the blockers, and
 * {@link buildAnchorFallbackSummarySupplement} gives the entrypoint the
 * full blocker detail to append to the summary comment instead (team-
 * lead's "no-anchorable-file fallback that degrades to summary" hardening
 * — the entrypoint is additionally responsible for exiting nonzero in this
 * case, a CLI-level concern this module only makes possible by exposing
 * the flag, never attempts itself).
 *
 * DIFF PARSING SAFETY: {@link selectDeterministicBlockerAnchor} parses a
 * unified diff's OWN structural syntax only (`+++ `/`@@ ... @@` header
 * lines, and `+`/`-`/` `/`\` hunk-content-line prefixes) — never diff
 * CONTENT as instructions. The genuinely hard case this parsing must
 * resist: an ADDED content line whose own text starts with `++ ` or
 * `@@ ` — the raw diff line then reads `+++ b/some/path` (outer `+`
 * marker plus the attacker's `++ b/...` text) or `+@@ -1,1 +1,1 @@ ...`,
 * indistinguishable BY LEADING BYTES ALONE from a real file/hunk header. A
 * byte-prefix check alone (as an earlier version of this function used)
 * is NOT sufficient here — `"+++ "` and `"--- "` file-header lines start
 * with the exact same `+`/`-` bytes a content line does, so a lookalike
 * content line would be misclassified as a real header, silently
 * resetting the tracked file/line and picking the WRONG anchor.
 *
 * The actual fix is STATE, not text-guessing: a hunk header's own OWN
 * declared counts (`@@ -oldStart,oldCount +newStart,newCount @@`) say
 * exactly how many old-side and new-side lines follow. Once a real `@@ `
 * header is seen (unambiguous — no content line prefix is `@`), this
 * parser consumes EXACTLY that many old/new lines by their leading byte
 * alone, NEVER re-checking those lines against the file/hunk-header
 * patterns at all — so a lookalike `+++ `/`@@ ` line inside a hunk's own
 * declared content is simply consumed as an ordinary `+` content line,
 * exactly as it should be. Only once both declared counts are exhausted
 * does the parser return to "structural line expected" mode and resume
 * checking for the next real header. This mirrors the same discipline
 * `spec-grounding-runner-logic.mts`'s own delimiter-neutralization
 * functions document: identify the real axis (here, the hunk's own
 * trusted declared line counts) rather than a text/substring check an
 * attacker's content could spoof.
 *
 * MUST be called with the RAW diff text — never the read-only review
 * job's own `pr-diff-block.txt` artifact, which has already been through
 * {@link neutralizeDiffDelimiterBreakout}/`escapeInvisibleCharactersVisibly`
 * (replacing invisible/exotic characters with visible `[U+XXXX]` markers)
 * and is wrapped in nonce-fenced delimiter tags — both would corrupt the
 * exact byte structure this parser relies on. The privileged publisher
 * fetches its own trusted copy of the diff independently (3b-iii-d+e).
 */

import {
  describeAddressedVsUnaddressedArtifactPointer,
  formatRationaleForDisplay,
} from "./publish-spec-grounding-verdict-logic.mts";
import type { JoinedCriterionResult, UnreviewedClosingIssueResult } from "./publish-spec-grounding-verdict-logic.mts";

/** A single deterministic anchor point in a PR's diff: a file path and a line number on the file's NEW (post-PR) side. */
export interface DiffAnchor {
  readonly path: string;
  readonly line: number;
}

/** Matches a unified diff hunk header, e.g. `@@ -12,3 +14,5 @@ optional section heading`. Captures the old-side count, the new-side start line, and the new-side count (all but the new start are optional, defaulting to 1 per the unified diff spec when a line has just one line and omits the count). Anchored to the line's start (no backtracking risk — single bounded match per line, never applied across multiple lines at once). Only ever matched when NOT already consuming a prior hunk's own declared content (see the function body) — this is what makes it safe against a content line that merely LOOKS like a hunk header. */
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Matches a unified diff's new-file header, e.g. `+++ b/scripts/factory/foo.mts`,
 * `+++ /dev/null` for a deleted file, or git's own QUOTED form for a path
 * containing a non-ASCII or otherwise "unusual" byte (PR #83 review,
 * Codex, LOW — a real-diff-format edge, not attacker-crafted): with
 * `core.quotePath` (git's own default) on, such a path is rendered
 * double-quoted with C-style escapes, e.g. `+++ "b/caf\303\251.ts"` for
 * `café.ts` (é is 0xC3 0xA9 in UTF-8, each byte its own `\NNN` octal
 * escape). Without recognizing this third form, a diff whose only added
 * lines live in a non-ASCII-filename file previously left `currentPath`
 * null for the WHOLE diff — a false `anchorFallbackNeeded` despite a
 * real anchor existing, degrading every such PR to the fallback summary
 * and failing the job (fails SAFE — the blocker still reaches the human
 * via that fallback — but an unnecessary red-X and degrade on an
 * otherwise-clean run). `/dev/null` is never quoted by git (it's a fixed
 * ASCII literal, never a real path), so only the `b/...` form needs a
 * quoted variant. Three mutually-exclusive capture groups, structurally
 * unambiguous by their own distinct starting characters (`b/`, the
 * literal `/dev/null`, or `"b/`) — group 3, when present, is the RAW
 * (still-escaped) quoted path content, decoded by {@link unquoteGitPath}.
 * Only ever matched in "structural line expected" state (see the
 * function body) — this is what makes it safe against a content line
 * that merely LOOKS like a file header.
 *
 * ALSO tolerates a trailing TAB-delimited suffix (PR #83 review, FOLD 1 —
 * a real-diff-format edge, same class as the quoted-path/CRLF fixes
 * above): git doesn't QUOTE a path for a plain SPACE alone (quoting is
 * for control/non-ASCII bytes, per this docstring's own quoted-path
 * paragraph — a space is ordinary and printable), so a path containing a
 * space would otherwise be genuinely ambiguous about where it ends. Git
 * resolves this by TAB-delimiting instead: `+++ b/space file.ts` becomes
 * `+++ b/space file.ts\t` (optionally followed by a timestamp, in diff
 * modes that emit one, e.g. `--no-index`). Group 1 (the unquoted branch)
 * excludes a literal tab from its own captured content (`[^\t]+`, not
 * `.+`) — a raw, unescaped tab byte can never legitimately appear inside
 * an unquoted path in the first place (git would have quoted it, being a
 * control byte), so any tab reached there is unambiguously the
 * delimiter, never filename content. Group 3 (the quoted branch) keeps
 * its own existing greedy-then-backtrack semantics unchanged (still finds
 * the real closing `"` correctly, including for a malformed trailing-
 * backslash input — see {@link unquoteGitPath}'s own fail-safe test) and
 * additionally tolerates an optional trailing `\t...` suffix AFTER that
 * closing quote via the shared trailing group below, rather than by
 * touching the DECODED path (a decoded tab there could be a genuine `\t`-
 * escaped filename character, not a delimiter — stripping post-decode
 * would risk truncating a real filename).
 */
const NEW_FILE_HEADER_PATTERN = /^\+\+\+ (?:b\/([^\t]+)|(\/dev\/null)|"b\/(.+)")(?:\t.*)?$/;

/**
 * Decodes git's own C-style path-quoting escapes (`core.quotePath`'s
 * default rendering) back to the real path — see {@link
 * NEW_FILE_HEADER_PATTERN}'s own docstring for why this exists. Handles
 * `\\`, `\"`, `\t`, `\n`, and `\NNN` (a single raw BYTE in octal — git
 * escapes a multi-byte UTF-8 character one byte at a time, never per
 * codepoint), building a raw byte sequence and decoding it as UTF-8 at
 * the end (an ordinary ASCII character appearing unescaped in the input
 * is already single-byte-identical to its own UTF-8 encoding, so it
 * passes through unchanged in the same byte sequence — git's own
 * quoting escapes every non-ASCII byte, never leaves one literal).
 *
 * @param quoted - The RAW (still-escaped) path content between the
 *   header's own quote marks — {@link NEW_FILE_HEADER_PATTERN}'s own
 *   third capture group, not including the `"` marks themselves.
 * @returns The decoded, real path.
 */
/**
 * Every single-character C-escape git's own path-quoting can emit,
 * besides the `\NNN` octal-byte form (handled separately in {@link
 * unquoteGitPath} itself) — the COMPLETE set (PR #83 review, LOW: an
 * earlier version only handled `\\`, `\"`, `\t`, `\n`; git also emits
 * `\a` (bell), `\b` (backspace), `\f` (form feed), `\r` (carriage
 * return), and `\v` (vertical tab) for the corresponding control bytes
 * in a filename — the previous fail-safe silently mis-decoded these
 * into a literal backslash + letter, the wrong path, a 422 on the
 * resulting API call). Git's own escape set is fixed and enumerable —
 * this map is exhaustive, not illustrative.
 */
const GIT_SINGLE_CHAR_ESCAPES: Readonly<Record<string, number>> = {
  "\\": 0x5c,
  '"': 0x22,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < quoted.length) {
    // Defensive: `i < quoted.length` already guarantees `quoted[i]` is
    // defined; the `?? ""` only satisfies TypeScript's
    // noUncheckedIndexedAccess narrowing and is unreachable in practice.
    /* v8 ignore next */
    const ch = quoted[i] ?? "";
    if (ch === "\\") {
      const octalMatch = /^[0-7]{3}/.exec(quoted.slice(i + 1));
      if (octalMatch) {
        bytes.push(Number.parseInt(octalMatch[0], 8));
        i += 1 + octalMatch[0].length;
        continue;
      }
      const next = quoted[i + 1];
      const singleCharByte = next === undefined ? undefined : GIT_SINGLE_CHAR_ESCAPES[next];
      if (singleCharByte !== undefined) {
        bytes.push(singleCharByte);
        i += 2;
        continue;
      }
      // Unknown/malformed escape -- not a sequence a real `git diff`
      // would ever produce (git's own escape set, above, is exhaustive),
      // but fail safe by passing the backslash through literally rather
      // than crashing or silently dropping it.
      bytes.push(0x5c);
      i += 1;
      continue;
    }
    bytes.push(ch.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Selects the single deterministic anchor point for every blocker inline
 * comment in this run: the first added (`+`) line of the first file (in
 * diff order) that has at least one. See this module's own top-level
 * docstring for the full reasoning and the parsing-safety discipline —
 * in particular, WHY a hunk's own declared line counts (not a leading-byte
 * guess) are what makes this safe against a content line that looks like
 * a structural header.
 *
 * @param diff - The RAW unified diff text (see this module's docstring —
 *   never the neutralized/wrapped block the read-only agent was shown).
 * @returns The anchor, or `null` if the diff has no addable line at all
 *   (empty diff, or a diff that only deletes content).
 */
export function selectDeterministicBlockerAnchor(diff: string): DiffAnchor | null {
  // Splits on a CRLF OR a bare LF (PR #82 round 3 review, holistic pass,
  // FOLD 5, LOW): a diff using CRLF line endings would otherwise leave a
  // trailing "\r" on every line -- for a "+++ b/<path>" line specifically,
  // NEW_FILE_HEADER_PATTERN's `(.+)` capture is greedy and its trailing
  // `$` anchors end-of-STRING, not end-of-line, so the "\r" gets silently
  // captured as part of the path (e.g. "foo.ts\r"), corrupting the value
  // this function hands to GitHub's create-review-comment API (a 422 on
  // the resulting call). Splitting on `\r?\n` strips it uniformly from
  // every line, not just the file-header one.
  const lines = diff.split(/\r?\n/);
  let currentPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    // Defensive: `i < lines.length` (the loop condition) already
    // guarantees `lines[i]` is defined; the `?? ""` only satisfies
    // TypeScript's noUncheckedIndexedAccess narrowing and is unreachable
    // in practice.
    /* v8 ignore next */
    const line = lines[i] ?? "";

    // "Structural line expected" state: only reached between hunks/files,
    // never while consuming a hunk's own declared content (below) — so a
    // lookalike content line can never reach this branch at all.
    const fileHeaderMatch = NEW_FILE_HEADER_PATTERN.exec(line);
    if (fileHeaderMatch) {
      if (fileHeaderMatch[3] !== undefined) {
        currentPath = unquoteGitPath(fileHeaderMatch[3]); // git's own quoted-path form, e.g. `+++ "b/café.ts"` (see NEW_FILE_HEADER_PATTERN's own docstring)
      } else {
        currentPath = fileHeaderMatch[1] ?? null; // null for `+++ /dev/null` (a deleted file: nothing addable there)
      }
      i += 1;
      continue;
    }

    const hunkHeaderMatch = HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeaderMatch) {
      let newLineNumber = Number(hunkHeaderMatch[2]);
      let oldRemaining = Number(hunkHeaderMatch[1] ?? "1");
      let newRemaining = Number(hunkHeaderMatch[3] ?? "1");
      i += 1;

      // Consume EXACTLY the declared number of old/new lines, by leading
      // byte alone -- never re-checked against the header patterns above,
      // no matter what a line's own text looks like.
      while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        // Same defensive narrowing as the outer loop's `line` above --
        // unreachable in practice, guaranteed defined by `i < lines.length`.
        /* v8 ignore next */
        const contentLine = lines[i] ?? "";
        if (contentLine.startsWith("+")) {
          if (currentPath !== null) {
            return { path: currentPath, line: newLineNumber };
          }
          newLineNumber += 1;
          newRemaining -= 1;
        } else if (contentLine.startsWith("-")) {
          oldRemaining -= 1;
        } else if (contentLine.startsWith(" ")) {
          newLineNumber += 1;
          newRemaining -= 1;
          oldRemaining -= 1;
        } else if (contentLine.startsWith("\\")) {
          // "\ No newline at end of file" -- doesn't count toward either side.
        } else {
          // A malformed/truncated hunk (declared counts not yet
          // exhausted but this line doesn't carry any known content
          // prefix): stop trusting this hunk's own declared counts and
          // fail safe by re-entering structural-line mode AT THIS LINE
          // (not advancing `i`), rather than risking miscounting through
          // an inconsistent hunk.
          break;
        }
        i += 1;
      }
      continue;
    }

    // Not a file header, not a hunk header (a "diff --git"/"index"/mode
    // line, a "--- a/X" old-file header we don't need, or a malformed
    // hunk's own trailing content re-entering structural mode above) --
    // just advance.
    i += 1;
  }

  return null;
}

/**
 * One inline comment this run should post, fully composed — path, line,
 * and body — ready for the entrypoint to pass straight to GitHub's create-
 * review-comment API.
 */
export interface BlockerCommentPlan {
  readonly path: string;
  readonly line: number;
  readonly body: string;
  /**
   * This comment's own stable idempotency marker (PR #12 d+e PR-plan
   * review — completes c's own contract before d is built), exactly the
   * same value embedded as `body`'s own last line — exposed as its own
   * field so the privileged publish entrypoint (3b-iii-d) can find-and-
   * update the right existing comment for the right planned entry
   * without re-parsing `body` text to locate it. Always one of {@link
   * criterionBlockerCommentMarker}, {@link
   * unreviewedClosingIssueCommentMarker}, {@link
   * CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER}, {@link
   * UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER}, or {@link
   * DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}.
   */
  readonly marker: string;
}

/**
 * Stable, content-independent idempotency marker embedded in every
 * blocker inline comment this module builds (PR #82 round 3 review,
 * holistic pass, FOLD 4 — MEDIUM: the summary comment already has
 * {@link SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} for exactly this purpose
 * — finding "our own" prior comment on a re-run to update in place
 * instead of posting a duplicate — but inline comment bodies had no
 * equivalent marker at all, so a re-run would duplicate every blocker
 * comment). Posting/dedup logic itself is a network-facing concern for
 * the entrypoint (3b-iii-d+e, not yet built); this module only supplies
 * the PRIMITIVE each body embeds, mirroring the summary marker's own
 * "fixed string, content-independent, never derived from untrusted
 * verdict data" design so a crafted rationale can never spoof it.
 *
 * One marker per CRITERION (`criterionId`, already a trusted,
 * spine-derived `<issueNumber>:<index>` string — no sanitization needed,
 * it never contains agent- or issue-authored content) or per ISSUE
 * (`issueNumber`) keeps each individual comment's identity stable across
 * re-runs even as OTHER findings change. The three aggregate/whole-run
 * comment kinds (overflow criteria, overflow issues, diff-truncated) each
 * get their own FIXED marker instead, since there is at most one such
 * comment per PR per kind regardless of which entries it currently lists.
 *
 * CAVEAT — `criterionId`'s stability is RUN-RELATIVE, not cross-run
 * absolute (PR #83 review, L364, team-lead's disposition — documented
 * here rather than fixed, see below): `criterionId` has the shape
 * `<issueNumber>:<index>`, where `index` is this criterion's POSITION in
 * the linked issue's own checkbox list at spine-build time. If that
 * issue's criteria are inserted, removed, or reordered BETWEEN two runs
 * of this workflow on the same PR, the `index` component shifts — a
 * cross-run find-and-update by marker (the not-yet-built publish
 * entrypoint, 3b-iii-d) could then match the marker of a DIFFERENT
 * criterion than the one it originally identified, updating the wrong
 * comment in place. Not fixed here because: (a) the actual trigger is an
 * issue edited between two review runs, which is issue #77's own scope
 * (issue-edit invalidation), not this module's; (b) a content-hash
 * marker isn't feasible as a replacement — the criterion's own TEXT is
 * deliberately kept OUT of the trusted spine (`criteria-spine.json` is
 * metadata-only: issue number, kind, index — never the checkbox text
 * itself, a deliberate security property, see `spec-grounding-runner-
 * logic.mts`), so this module has no criterion text available to hash
 * even if it wanted to. This marker is stable across re-runs ONLY while
 * the linked issue's own criteria are unchanged; cross-run identity
 * under a criteria-changing edit is tracked as part of #77, not solved
 * here.
 *
 * @param criterionId - The spine-trusted `criterionId` this inline
 *   comment is about.
 * @returns The marker string to append as the LAST line of the comment
 *   body, matching {@link SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}'s own
 *   placement convention.
 */
export function criterionBlockerCommentMarker(criterionId: string): string {
  return `<!-- roastpilot-factory:spec-grounding-blocker:criterion:${criterionId}:do-not-edit -->`;
}

/**
 * Sibling of {@link criterionBlockerCommentMarker}, for one whole
 * unreviewed CLOSING issue's own inline comment.
 *
 * @param issueNumber - The issue number this inline comment is about.
 * @returns The marker string to append as the LAST line of the comment body.
 */
export function unreviewedClosingIssueCommentMarker(issueNumber: number): string {
  return `<!-- roastpilot-factory:spec-grounding-blocker:issue:${issueNumber}:do-not-edit -->`;
}

/** Fixed marker for the ONE aggregated criterion-blocker overflow comment a run can have, appended as its last line. */
export const CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER =
  "<!-- roastpilot-factory:spec-grounding-blocker:criteria-aggregate:do-not-edit -->";

/** Fixed marker for the ONE aggregated unreviewed-closing-issue overflow comment a run can have, appended as its last line. */
export const UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER =
  "<!-- roastpilot-factory:spec-grounding-blocker:issues-aggregate:do-not-edit -->";

/** Fixed marker for the ONE whole-run diff-truncated blocker comment a run can have, appended as its last line. */
export const DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER =
  "<!-- roastpilot-factory:spec-grounding-blocker:diff-truncated:do-not-edit -->";

/**
 * Builds the GENERATION marker line every blocker inline comment now
 * carries ALONGSIDE (never instead of) its own identity marker (F1-S9
 * slice 90.3, the #90 PR-plan's own foundational item, #88) — a
 * SEPARATE, additive line, deliberately NOT folded into the identity
 * marker string itself (team-lead's design ruling, PR #93/90.2-adjacent
 * discussion, "Option A"): the identity markers above (and their
 * matcher, `publish-spec-grounding-inline-comment-io.mts`'s own
 * `findExistingInlineCommentId`) rely on EXACT structural line equality
 * — deliberately never a pattern match — for the "find our own prior
 * comment to update in place" idempotency this whole module depends on.
 * Folding a variable generation number into that SAME matched string
 * would force replacing exact-line equality with a pattern match that
 * treats the generation as a wildcard, reopening the "could crafted
 * content spuriously match" risk class the delimiter-tag guards
 * (`spec-grounding-logic.mts`/`spec-grounding-runner-logic.mts`) took
 * multiple review rounds to close — on the PRIVILEGED write/delete
 * surface, not a read-only one. A second, independent marker line for
 * the generation preserves the identity marker's own exact-match
 * property completely unchanged, at the cost of one extra line per
 * comment.
 *
 * DATA-ONLY as of this slice (matches F1-S9 slice 90.2's own precedent
 * for `reviewedClosingIssueNumbers`): embedded and round-trip-tested
 * now, but not yet CONSUMED by any delete-comparison logic —
 * `clearStaleInlineBlockerComments` (`publish-spec-grounding-inline-
 * comment-io.mts`) is untouched by this slice. The generation-aware
 * delete comparison ("only delete a marker whose generation is <= this
 * run's own") lands in slice 90.4.
 *
 * @param generation - `github.run_number`'s own value for this run, as
 *   a plain digit string (never `run_id` — see this constant's own
 *   caller, `publish-spec-grounding-verdict.mts`'s `main()`, for why
 *   `run_number`'s documented per-workflow monotonicity is the property
 *   90.4's own comparison needs, which `run_id` does not guarantee).
 * @returns The marker line to append to a blocker comment body,
 *   alongside (never replacing) that comment's own identity marker.
 */
export function inlineBlockerGenerationMarker(generation: string): string {
  return `<!-- roastpilot-factory:spec-grounding-blocker:generation:${generation}:do-not-edit -->`;
}

/**
 * Matches {@link inlineBlockerGenerationMarker}'s own COMPLETE line
 * shape, capturing the generation digits (group 1) — anchored `^...$`
 * against the WHOLE line, never a substring search, mirroring {@link
 * import("./publish-spec-grounding-verdict-logic.mts").bodyContainsMarkerAsStandaloneLine}'s
 * own "exact structural line, never substring" discipline exactly. The
 * only departure from a fixed constant string, matching every OTHER
 * marker in this file, is this one captured digit group.
 */
const INLINE_BLOCKER_GENERATION_MARKER_LINE_PATTERN =
  /^<!-- roastpilot-factory:spec-grounding-blocker:generation:(\d+):do-not-edit -->$/;

/**
 * Reads a blocker comment's own generation back out of its body, if
 * present — the read-back half of {@link inlineBlockerGenerationMarker}
 * (F1-S9 slice 90.3). Scans EVERY line for an exact, standalone match
 * against {@link INLINE_BLOCKER_GENERATION_MARKER_LINE_PATTERN} (never a
 * substring search across the whole body), the SAME per-line-exact
 * discipline {@link bodyContainsAnyBlockerMarker} already uses for this
 * file's other markers.
 *
 * UNUSED by any delete-comparison logic as of this slice (see {@link
 * inlineBlockerGenerationMarker}'s own docstring) — round-trip-tested
 * here so slice 90.4's own comparison has an already-correct,
 * already-reviewed primitive to call, rather than writing and reviewing
 * it under that later slice's own time pressure.
 *
 * @param body - A comment's own body text — the caller is responsible
 *   for having already confirmed this comment is bot-authored under
 *   this workflow's own identity before trusting anything read back
 *   from it (matching every other marker-reading function in this
 *   pipeline).
 * @returns The generation number, or `null` if no matching line exists,
 *   or the captured digits do not form a safe integer (defensive —
 *   this workflow's own `github.run_number` is always a small, genuine
 *   positive integer, never influenced by PR content, but this function
 *   never assumes that of content it did not itself just write).
 */
export function extractInlineBlockerGeneration(body: string): number | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const match = INLINE_BLOCKER_GENERATION_MARKER_LINE_PATTERN.exec(rawLine.trim());
    if (match === null) {
      continue;
    }
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Matches ANY of this module's five own marker shapes ({@link
 * criterionBlockerCommentMarker}, {@link unreviewedClosingIssueCommentMarker},
 * {@link CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER}, {@link
 * UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER}, {@link
 * DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}) as a single pattern — every one
 * shares the exact `<!-- roastpilot-factory:spec-grounding-blocker:...
 * :do-not-edit -->` prefix/suffix, varying only the middle segment. Used
 * by the privileged publish entrypoint (PR #86 review, Codex, P2 —
 * clearing stale inline blocker comments when a PR's linked criteria
 * disappear entirely) to find "any inline blocker comment this workflow
 * ever posted on this PR", generically, without needing THIS run's own
 * plan (there is no plan at all once criteria are gone) to match a
 * specific marker against.
 */
const ANY_BLOCKER_MARKER_LINE_PATTERN = /^<!-- roastpilot-factory:spec-grounding-blocker:.+:do-not-edit -->$/;

/**
 * Whether `body` carries any ONE of this module's five marker shapes as a
 * STRUCTURAL, standalone-line match — the same "exact line, never a loose
 * substring" discipline {@link
 * import("./publish-spec-grounding-verdict-logic.mts").bodyContainsMarkerAsStandaloneLine}
 * applies to the summary comment's own single marker, generalized here to
 * "any of the five", via {@link ANY_BLOCKER_MARKER_LINE_PATTERN}.
 *
 * @param body - A comment's own body text.
 * @returns `true` only if some line of `body`, trimmed, matches the shared
 *   blocker-marker pattern exactly.
 */
export function bodyContainsAnyBlockerMarker(body: string): boolean {
  return body.split(/\r?\n/).some((line) => ANY_BLOCKER_MARKER_LINE_PATTERN.test(line.trim()));
}

/**
 * The self-describing preamble every blocker inline comment carries,
 * explaining that its anchor is a deterministic placement, not the actual
 * defect location (team-lead's hardening — see this module's own
 * top-level docstring).
 */
function anchorCaveat(): string {
  return (
    "_This comment is anchored to the first changed line in this PR's diff as a deterministic " +
    "placement — it does not necessarily mark the specific code that implements, or fails to " +
    "implement, this finding. See the finding itself, below, for what was actually judged._"
  );
}

/**
 * Builds the inline comment body for the WHOLE-RUN blocker that fires
 * when this PR's own diff was truncated AND the run has at least one
 * closing-kind reference (PR #82 round 3 review, holistic pass, FOLD 3 —
 * see `publish-spec-grounding-verdict-logic.mts`'s own {@link
 * isDiffTruncationUnverifiableForClosing} for the full reasoning: a
 * truncated diff makes every criterion judged against it unverifiable,
 * including one marked `satisfied: true`, not just the criteria set
 * incomplete). Unlike the other blocker builders, this one is not tied
 * to any specific criterion or issue — the caller decides ONCE per run
 * whether to include it (see {@link planBlockerInlineComments}'s own
 * `diffTruncationBlocksClosingClaim` parameter).
 *
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3) — see {@link
 *   inlineBlockerGenerationMarker}'s own docstring for the full design
 *   reasoning.
 * @returns The Markdown comment body.
 */
export function buildDiffTruncatedBlockerCommentBody(generation: string): string {
  return [
    "**Blocking: this PR's own diff was truncated**",
    "",
    "This run's diff exceeded a resource cap (byte size, or GitHub's compare-API 300-file limit) " +
      "and was truncated before the review agent judged it. This PR has at least one closing-kind " +
      "reference, so every criterion judged against this diff — including any marked satisfied — " +
      "is unverifiable: the agent may never have seen the part of the diff that would have shown a " +
      "criterion still unmet. The claim to close the relevant issue(s) cannot be confirmed from " +
      "this run alone.",
    "",
    anchorCaveat(),
    "",
    DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
    inlineBlockerGenerationMarker(generation),
  ].join("\n");
}

/**
 * Builds the inline comment body for one CLOSING criterion the reviewer
 * found unsatisfied (or never addressed at all — see {@link
 * JoinedCriterionResult.addressedByReviewer}).
 *
 * Renders the rationale via `publish-spec-grounding-verdict-logic.mts`'s
 * own {@link formatRationaleForDisplay} — the SAME function the summary
 * comment uses, not a separate copy of the same logic — so the
 * Markdown-injection neutralization + length cap that function applies
 * (PR #82 review, FOLDs 2/3) covers this inline comment too. An earlier
 * version of this function duplicated the rationale-formatting logic
 * inline instead of importing it, which would have shipped the identical
 * injection gap here, undetected, since this module's own PR hadn't been
 * reviewed yet when that finding landed on the sibling PR.
 *
 * @param entry - A joined result with `deriveSeverity(entry) === "blocker"`
 *   (the caller is responsible for filtering to blockers only —
 *   this function does not re-check severity itself).
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3) — see {@link
 *   inlineBlockerGenerationMarker}'s own docstring for the full design
 *   reasoning.
 * @returns The Markdown comment body.
 */
export function buildCriterionBlockerCommentBody(entry: JoinedCriterionResult, generation: string): string {
  return [
    `**Blocking: unmet acceptance criterion on issue #${entry.issueNumber}**`,
    "",
    `This PR's own closing keyword claims to fully resolve issue #${entry.issueNumber}, but ` +
      `criterion \`${entry.criterionId}\` was found unsatisfied: ${formatRationaleForDisplay(entry)}`,
    "",
    anchorCaveat(),
    "",
    criterionBlockerCommentMarker(entry.criterionId),
    inlineBlockerGenerationMarker(generation),
  ].join("\n");
}

/**
 * Builds the inline comment body for one whole CLOSING-kind issue this PR
 * referenced whose review is incomplete — see {@link
 * UnreviewedClosingIssueResult}'s own docstring for the fully-dropped vs
 * partially-truncated distinction. Renders a DISTINCT explanation per
 * `truncationKind` (PR #82 round 2 review, FOLD 1): a fully-dropped issue
 * had NOTHING reviewed at all, while a partially-truncated one had SOME
 * criteria reviewed and some cut — different enough claims that
 * collapsing them into one message would misstate which case applies.
 *
 * @param entry - The unreviewed closing issue.
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3) — see {@link
 *   inlineBlockerGenerationMarker}'s own docstring for the full design
 *   reasoning.
 * @returns The Markdown comment body.
 */
export function buildDroppedClosingIssueBlockerCommentBody(
  entry: UnreviewedClosingIssueResult,
  generation: string,
): string {
  const isPartial = entry.truncationKind === "partially-truncated";
  return [
    `**Blocking: issue #${entry.issueNumber} was ${isPartial ? "only partially reviewed" : "never reviewed"}**`,
    "",
    `This PR's own closing keyword claims to fully resolve issue #${entry.issueNumber}, but ` +
      (isPartial
        ? "only SOME of that issue's acceptance criteria made it into this run's reviewed set — a " +
          "resource cap truncated the rest before the review agent ever saw them. A partial review " +
          "cannot confirm the whole issue is resolved."
        : "none of that issue's acceptance criteria made it into this run's reviewed set at all — a " +
          "resource cap dropped it before the review agent ever saw it.") +
      " Treat this the same as an unsatisfied criterion: the claim to close this issue is unverified.",
    "",
    anchorCaveat(),
    "",
    unreviewedClosingIssueCommentMarker(entry.issueNumber),
    inlineBlockerGenerationMarker(generation),
  ].join("\n");
}

/**
 * Upper bound on how many {@link UnreviewedClosingIssueResult} entries get
 * their OWN individual inline comment before the remainder is aggregated
 * into one bounded comment instead (PR #82 round 2 review, FOLD 2,
 * BLOCKER — see this module's own top-level docstring for the full
 * API-abuse reasoning). Small enough that a realistic PR referencing a
 * handful of closing issues still gets the more-readable individual
 * treatment; small enough that even a maximally-crafted PR body can never
 * push the write-API call count for this category past a fixed constant.
 */
export const MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS = 5;

/**
 * Upper bound on how many {@link JoinedCriterionResult} blockers get their
 * OWN individual inline comment before the remainder is aggregated into
 * one bounded comment instead (PR #82 round 3 review, holistic pass,
 * BLOCKER 1 — see this module's own top-level docstring for the full
 * API-abuse reasoning: an EARLIER version's docstring claimed
 * `criterionBlockers` was "inherently bounded" by the fixed
 * `MAX_LINKED_ISSUES × MAX_CRITERIA_PER_ISSUE` ceiling and therefore safe
 * to leave uncapped — TRUE that the ceiling is fixed, FALSE that it is
 * safe: both factors (which issues are linked, and how many checkbox
 * criteria each one's body lists) are attacker-editable, since a linked
 * issue is a public GitHub issue anyone can edit and the PR body itself
 * names which issues are linked. 20 × 50 is a fixed NUMBER, but a fully
 * attacker-controlled one — ~1000 potential inline write calls, all on
 * the same shared anchor line, is exactly the abuse-rate-limit and spam
 * class {@link MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS} already closed
 * for the smaller `unreviewedClosingIssues` source; this constant closes
 * the larger one).
 */
export const MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS = 5;

/**
 * Builds ONE aggregated comment body for every {@link
 * JoinedCriterionResult} blocker beyond {@link
 * MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS} — bounded in BOTH count
 * (never more than one comment, regardless of how many entries) and
 * length (only names the first {@link MAX_AGGREGATE_LISTED_CRITERIA}
 * criteria, then an "and N more" note). Deliberately does NOT include
 * each entry's own rationale (unlike the individual-comment builder) —
 * keeping the aggregate lightweight and pointing to the uploaded verdict
 * artifact for full detail, the same lighter-weight-aggregate pattern
 * {@link buildAggregatedUnreviewedClosingIssuesCommentBody} already
 * established.
 *
 * Distinguishes an entry the reviewer actually ADDRESSED (found
 * unsatisfied — has a rationale) from one it never addressed at all
 * (`addressedByReviewer: false`, defaulting to unsatisfied — see {@link
 * JoinedCriterionResult}'s own docstring), both per listed entry and in
 * the closing artifact pointer (PR #83 review, FOLD 2 — an earlier
 * version labeled every listed entry "found unsatisfied" and pointed all
 * of them at "the uploaded verdict artifact" regardless, which is simply
 * wrong for an unaddressed one: there is no verdict entry for it at all,
 * only a criteria-spine one. Uses {@link
 * describeAddressedVsUnaddressedArtifactPointer} — the SAME shared clause
 * `buildSpecGroundingSummaryCommentBody`'s own omitted-findings note uses
 * — rather than a second, independently-worded copy that could drift).
 *
 * @param entries - The overflow entries beyond the individual-comment cap.
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3) — see {@link
 *   inlineBlockerGenerationMarker}'s own docstring for the full design
 *   reasoning.
 * @returns The Markdown comment body.
 */
export function buildAggregatedCriterionBlockersCommentBody(
  entries: readonly JoinedCriterionResult[],
  generation: string,
): string {
  const MAX_AGGREGATE_LISTED_CRITERIA = 20;
  const listed = entries.slice(0, MAX_AGGREGATE_LISTED_CRITERIA);
  const remainder = entries.length - listed.length;
  const describedCriteria = listed
    .map(
      (e) =>
        `issue #${e.issueNumber} criterion \`${e.criterionId}\` (${
          e.addressedByReviewer ? "found unsatisfied" : "not addressed by the reviewer"
        })`,
    )
    .join(", ");
  const remainderNote = remainder > 0 ? `, and ${remainder} more` : "";
  return [
    `**Blocking: ${entries.length} more unmet acceptance criterion(a)**`,
    "",
    `This PR's own closing keyword(s) claim to fully resolve the relevant issue(s), but ` +
      `${describedCriteria}${remainderNote} are all treated as unsatisfied — aggregated into one ` +
      "comment (PR #82 round 3 review, BLOCKER 1) rather than one inline comment per criterion, " +
      "since this run's own findings named more unsatisfied criteria than individual comments are " +
      "posted for. Treat every one of these the same as any other unsatisfied criterion: the claim " +
      `to close the relevant issue(s) is unverified (${describeAddressedVsUnaddressedArtifactPointer("entry")}).`,
    "",
    anchorCaveat(),
    "",
    CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER,
    inlineBlockerGenerationMarker(generation),
  ].join("\n");
}

/**
 * Builds ONE aggregated comment body for every {@link
 * UnreviewedClosingIssueResult} beyond {@link
 * MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS} — bounded in BOTH count
 * (never more than one comment, regardless of how many entries) and
 * length (only names the first {@link MAX_AGGREGATE_LISTED_ISSUES}
 * issue numbers, then an "and N more" note — never renders an unbounded
 * list even within this one comment).
 *
 * @param entries - The overflow entries beyond the individual-comment cap.
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3) — see {@link
 *   inlineBlockerGenerationMarker}'s own docstring for the full design
 *   reasoning.
 * @returns The Markdown comment body.
 */
export function buildAggregatedUnreviewedClosingIssuesCommentBody(
  entries: readonly UnreviewedClosingIssueResult[],
  generation: string,
): string {
  const MAX_AGGREGATE_LISTED_ISSUES = 20;
  const listed = entries.slice(0, MAX_AGGREGATE_LISTED_ISSUES);
  const remainder = entries.length - listed.length;
  const describedIssues = listed
    .map((e) => `#${e.issueNumber} (${e.truncationKind === "partially-truncated" ? "partially reviewed" : "never reviewed"})`)
    .join(", ");
  const remainderNote = remainder > 0 ? `, and ${remainder} more` : "";
  return [
    `**Blocking: ${entries.length} more issue(s) not fully reviewed**`,
    "",
    `This PR's own closing keywords claim to fully resolve ${describedIssues}${remainderNote}, but ` +
      "each one's review is incomplete (either nothing was reviewed at all, or only some of its " +
      "criteria were, before a resource cap cut the rest) — a resource cap, not the review agent's " +
      "own judgment. Treat every one of these the same as an unsatisfied criterion: the claim to " +
      "close them is unverified. Aggregated into one comment (PR #82 round 2 review, FOLD 2) rather " +
      "than one inline comment per issue, since this PR's own body names more closing issues than " +
      "individual comments are posted for.",
    "",
    anchorCaveat(),
    "",
    UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER,
    inlineBlockerGenerationMarker(generation),
  ].join("\n");
}

/**
 * The result of planning this run's blocker inline comments: either a
 * fully composed set of comments sharing one deterministic anchor, or a
 * signal that no anchor exists at all (empty diff, or a diff with no
 * added line anywhere) and the caller must degrade to the summary comment
 * instead — and, per team-lead's hardening, exit the job nonzero (a
 * CLI-level concern this module only surfaces the flag for; see this
 * module's own top-level docstring).
 */
export interface BlockerCommentPlanResult {
  readonly comments: readonly BlockerCommentPlan[];
  readonly anchorFallbackNeeded: boolean;
}

/**
 * Every reason the privileged publish entrypoint can degrade from
 * "posted inline" to "listed in the summary instead" (PR #87 review
 * round 4, Codex, P1 — an earlier version collapsed both into the same
 * `blockersPostedInline: false`, so the rendered summary misdiagnosed
 * WHICH case actually happened):
 * - `"no-addable-anchor"` — {@link planBlockerInlineComments}'s own
 *   `anchorFallbackNeeded: true`: this PR's diff genuinely has no
 *   addable line to anchor a comment to at all (an empty diff, or a
 *   diff that only deletes content). No anchor was ever attempted.
 * - `"anchor-rejected-422"` — a real anchor WAS selected and the FIRST
 *   genuine create attempt was sent, but GitHub's own create-review-
 *   comment API rejected it with a 422 (see `publish-spec-grounding-
 *   inline-comment-io.mts`'s own 422-probe-then-degrade docstring for
 *   why only the first attempt is diagnostic). A materially different
 *   situation from the anchor-absent case — an anchor existed and was
 *   tried, GitHub itself refused it.
 */
export type InlinePostingDegradeReason = "no-addable-anchor" | "anchor-rejected-422";

/**
 * Plans this run's blocker inline comments.
 *
 * BOTH `criterionBlockers` beyond {@link
 * MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS} AND `unreviewedClosingIssues`
 * beyond {@link MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS} are aggregated
 * into their own ONE bounded comment each, rather than one comment per
 * entry (PR #82 round 2 review FOLD 2 for the latter, round 3 review
 * BLOCKER 1 for the former — see {@link
 * MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS}'s own docstring for why an
 * EARLIER version's claim that `criterionBlockers` was "inherently
 * bounded" and safe to leave uncapped was false: both factors behind its
 * fixed `MAX_LINKED_ISSUES × MAX_CRITERIA_PER_ISSUE` ceiling are
 * attacker-editable).
 *
 * @param criterionBlockers - Joined results already filtered to
 *   `deriveSeverity(entry) === "blocker"` by the caller.
 * @param unreviewedClosingIssues - `criteria-spine.json`'s own
 *   `unreviewedClosingIssues` field for this run.
 * @param diff - The RAW unified diff text (see this module's own
 *   docstring for why it must not be the neutralized/wrapped block).
 * @param diffTruncationBlocksClosingClaim - `publish-spec-grounding-
 *   verdict-logic.mts`'s own {@link isDiffTruncationUnverifiableForClosing}
 *   result for this run (PR #82 round 3 review, holistic pass, FOLD 3) —
 *   computed ONCE by the caller from this run's trusted spine data,
 *   passed in rather than recomputed here, so the summary comment and
 *   this inline-comment plan can never disagree on whether this
 *   whole-run blocker fires.
 * @param generation - `github.run_number`'s own value for this run, as a
 *   plain digit string (F1-S9 slice 90.3), threaded into every planned
 *   comment's own body via {@link inlineBlockerGenerationMarker} — see
 *   that function's own docstring for the full design reasoning.
 * @returns `{ comments: [], anchorFallbackNeeded: false }` when there are
 *   no blockers at all (nothing to do); `{ comments: [], anchorFallbackNeeded:
 *   true }` when there are blockers but the diff has no anchor point;
 *   otherwise one {@link BlockerCommentPlan} per individual (up to each
 *   own cap) criterion blocker and unreviewed closing issue, plus at most
 *   one aggregated comment per category for any overflow, plus (when
 *   `diffTruncationBlocksClosingClaim` is `true`) exactly one whole-run
 *   diff-truncation blocker comment, all sharing the single deterministic
 *   anchor.
 */
export function planBlockerInlineComments(
  criterionBlockers: readonly JoinedCriterionResult[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
  diff: string,
  diffTruncationBlocksClosingClaim: boolean,
  generation: string,
): BlockerCommentPlanResult {
  if (
    criterionBlockers.length === 0 &&
    unreviewedClosingIssues.length === 0 &&
    !diffTruncationBlocksClosingClaim
  ) {
    return { comments: [], anchorFallbackNeeded: false };
  }

  const anchor = selectDeterministicBlockerAnchor(diff);
  if (anchor === null) {
    return { comments: [], anchorFallbackNeeded: true };
  }

  const individualCriteria = criterionBlockers.slice(0, MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS);
  const overflowCriteria = criterionBlockers.slice(MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS);
  const individualIssues = unreviewedClosingIssues.slice(0, MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS);
  const overflowIssues = unreviewedClosingIssues.slice(MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS);

  const comments: BlockerCommentPlan[] = [
    ...individualCriteria.map((entry) => ({
      path: anchor.path,
      line: anchor.line,
      body: buildCriterionBlockerCommentBody(entry, generation),
      marker: criterionBlockerCommentMarker(entry.criterionId),
    })),
    ...(overflowCriteria.length > 0
      ? [
          {
            path: anchor.path,
            line: anchor.line,
            body: buildAggregatedCriterionBlockersCommentBody(overflowCriteria, generation),
            marker: CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER,
          },
        ]
      : []),
    ...individualIssues.map((entry) => ({
      path: anchor.path,
      line: anchor.line,
      body: buildDroppedClosingIssueBlockerCommentBody(entry, generation),
      marker: unreviewedClosingIssueCommentMarker(entry.issueNumber),
    })),
    ...(overflowIssues.length > 0
      ? [
          {
            path: anchor.path,
            line: anchor.line,
            body: buildAggregatedUnreviewedClosingIssuesCommentBody(overflowIssues, generation),
            marker: UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER,
          },
        ]
      : []),
    ...(diffTruncationBlocksClosingClaim
      ? [
          {
            path: anchor.path,
            line: anchor.line,
            body: buildDiffTruncatedBlockerCommentBody(generation),
            marker: DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
          },
        ]
      : []),
  ];

  return { comments, anchorFallbackNeeded: false };
}

/**
 * Builds the full-detail blocker section the entrypoint appends to the
 * summary comment when {@link BlockerCommentPlanResult.anchorFallbackNeeded}
 * is `true` — the ONLY case where blocker detail belongs in the summary
 * rather than a resolvable inline thread (`publish-spec-grounding-verdict-
 * logic.mts`'s own `buildSpecGroundingSummaryCommentBody` deliberately
 * omits blocker detail otherwise, precisely so a human can't "resolve" a
 * blocker by reading the summary alone while its real inline thread stays
 * open — that reasoning doesn't apply here, since there IS no inline
 * thread to resolve).
 *
 * BOTH `criterionBlockers` beyond {@link
 * MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS} AND `unreviewedClosingIssues`
 * beyond {@link MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS} are summarized
 * with an omitted-count note rather than listed individually (PR #82
 * round 2 review's FOLD 2 for the latter; round 3 review's holistic pass
 * for the former — an EARLIER version of this function left
 * `criterionBlockers` unbounded here even after {@link
 * planBlockerInlineComments} was capped, so the same crafted-PR-body
 * vector could still make THIS function's own returned string grow
 * unboundedly — a caller appends it to a summary comment that otherwise
 * already has its own length guard for a DIFFERENT section, and a
 * ~1000-criterion-blocker run could push the combined POST past GitHub's
 * 65,536-character limit, making the summary POST itself fail — the
 * WORST outcome here, since the anchor-fallback path is the one place
 * blocker detail has no other home at all; losing it silently would mean
 * NO gating signal reaches the human reviewer for this run).
 *
 * Also reports the whole-run diff-truncation blocker (PR #82 round 3
 * review, holistic pass, FOLD 3) when `diffTruncationBlocksClosingClaim`
 * is `true` — the identical "no other home for it" reasoning applies:
 * with no anchor available, {@link planBlockerInlineComments} can't post
 * it as an inline comment either, so it belongs here or nowhere.
 *
 * The criterion-blocker OVERFLOW note (beyond the individual-listing cap)
 * uses the SAME shared {@link describeAddressedVsUnaddressedArtifactPointer}
 * clause {@link buildAggregatedCriterionBlockersCommentBody} and
 * `publish-spec-grounding-verdict-logic.mts`'s own summary omitted-count
 * note use (PR #83 review, FOLD 3 — the third and final site of the same
 * mislabeling bug: an EARLIER version unconditionally pointed every
 * overflow entry at "the uploaded verdict artifact", wrong for one the
 * reviewer never addressed at all, which has no verdict entry). The
 * INDIVIDUALLY-listed entries above, in contrast, already render
 * correctly for both cases — they go through {@link
 * formatRationaleForDisplay}, the same shared function that already
 * branches on `addressedByReviewer`.
 *

 * @param criterionBlockers - Joined results already filtered to blockers.
 * @param unreviewedClosingIssues - This run's unreviewed closing issues.
 * @param diffTruncationBlocksClosingClaim - `publish-spec-grounding-
 *   verdict-logic.mts`'s own {@link isDiffTruncationUnverifiableForClosing}
 *   result for this run — same value passed to {@link
 *   planBlockerInlineComments}, so the two never disagree.
 * @param degradeReason - WHY inline posting was not used (PR #87 review
 *   round 4, Codex, P1 — the opening explanation line now differs by
 *   reason instead of always assuming the anchor-absent case): pass
 *   `"no-addable-anchor"` when {@link planBlockerInlineComments}'s own
 *   `anchorFallbackNeeded` was `true`, or `"anchor-rejected-422"` when a
 *   real anchor was selected and tried but GitHub itself rejected it.
 * @returns The Markdown section to append, or `""` if there is nothing to
 *   report (the caller should only call this when `anchorFallbackNeeded`
 *   is `true`, but an empty-input call degrades safely to an empty string
 *   rather than an empty, confusing heading).
 */
export function buildAnchorFallbackSummarySupplement(
  criterionBlockers: readonly JoinedCriterionResult[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
  diffTruncationBlocksClosingClaim: boolean,
  degradeReason: InlinePostingDegradeReason,
): string {
  if (
    criterionBlockers.length === 0 &&
    unreviewedClosingIssues.length === 0 &&
    !diffTruncationBlocksClosingClaim
  ) {
    return "";
  }

  const openingExplanation =
    degradeReason === "no-addable-anchor"
      ? "this PR's diff has no addable line to anchor them to (an empty diff, or a diff that only " +
        "deletes content)"
      : "GitHub itself rejected the deterministic anchor this run selected (a 422 on the first " +
        "attempt) — our own textual diff parsing and GitHub's own internal diff-position mapping " +
        "disagreed at the edges";
  const lines: string[] = [
    `> ⚠️ **Blocking findings could not be posted as inline comments** — ${openingExplanation}. ` +
      "Listed here in full instead, since there is no inline thread for them:",
    "",
  ];

  const individualCriteria = criterionBlockers.slice(0, MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS);
  const overflowCriteriaCount = criterionBlockers.length - individualCriteria.length;
  for (const entry of individualCriteria) {
    // formatRationaleForDisplay (publish-spec-grounding-verdict-logic.mts)
    // -- same shared function buildCriterionBlockerCommentBody uses,
    // never a separate copy -- covers the Markdown-injection
    // neutralization + length cap (PR #82 review, FOLDs 2/3/4) here too.
    lines.push(
      `- Issue #${entry.issueNumber}, criterion \`${entry.criterionId}\`: **unsatisfied** — ${formatRationaleForDisplay(entry)}`,
    );
  }
  if (overflowCriteriaCount > 0) {
    lines.push(
      `- _(${overflowCriteriaCount} more unmet acceptance criterion(a) also treated as unsatisfied — ` +
        "this run's own findings named more than can be listed individually here " +
        `(${describeAddressedVsUnaddressedArtifactPointer("entry")}).)_`,
    );
  }
  const individualIssues = unreviewedClosingIssues.slice(0, MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS);
  const overflowIssueCount = unreviewedClosingIssues.length - individualIssues.length;
  for (const entry of individualIssues) {
    const description =
      entry.truncationKind === "partially-truncated"
        ? "**only partially reviewed** (some criteria truncated away by a resource cap)."
        : "**never reviewed at all** (truncated away by a resource cap).";
    lines.push(`- Issue #${entry.issueNumber}: ${description}`);
  }
  if (overflowIssueCount > 0) {
    lines.push(
      `- _(${overflowIssueCount} more issue(s) also not fully reviewed — this PR's own body names ` +
        "more closing issues than can be listed individually here; see the uploaded verdict " +
        "artifact / criteria-spine.json for the full list.)_",
    );
  }
  if (diffTruncationBlocksClosingClaim) {
    lines.push(
      "- **This PR's own diff was truncated**, and this run has at least one closing-kind " +
        "reference — every criterion judged against this diff, including any marked satisfied, " +
        "is unverifiable.",
    );
  }
  lines.push("");

  return lines.join("\n");
}
