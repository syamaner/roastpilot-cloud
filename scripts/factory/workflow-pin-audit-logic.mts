/**
 * Pure logic behind the F1-S7 (issue #10) "no unpinned/wildcard
 * claude-code-action usage survives" regression check.
 *
 * S7.1's own AC calls for "a version/SHA check + a grep-based test" —
 * deliberately regex-based rather than a full YAML parse: the invariant
 * this guards is narrow and textual (every `claude-code-action@` reference
 * pins to the one reviewed-and-approved commit SHA; no `allowed_bots` /
 * `allowed_non_write_users` value is a bare `*` wildcard), and a real YAML
 * parse would need a new dependency for a check this simple. Nothing here
 * touches the filesystem — the caller (the test file) reads the actual
 * `.github/workflows/*.yml` files and passes their raw text in, so this
 * logic stays unit-testable against synthetic fixtures independent of the
 * real files.
 *
 * HARDENED (F1-S7 pre-open, factory-security review round 1 — a
 * vacuously-passing supply-chain guard is worse than none):
 * - the action-pin check now flags EVERY textual `claude-code-action@<ref>`
 *   occurrence, not just `uses:` lines, so a hand-duplicated SHA elsewhere
 *   (e.g. a provenance env var string) can't drift silently — see
 *   {@link findUnpinnedActionReferences}'s own docstring;
 * - the wildcard-allowlist check now strips a trailing YAML comment before
 *   testing the end anchor, and also recognizes the YAML block-list form
 *   (`key:` on one line, `- '*'` on the next) — see
 *   {@link findWildcardAllowlistUsages}'s own docstring for the two bypass
 *   forms this closes.
 */

/**
 * The `claude-code-action` commit SHA every workflow file in this repo is
 * currently pinned to (`v1.0.176`, at/after the `v1.0.94`
 * bot-allowlist-bypass fix — see any of the workflow files' own comments
 * next to their `uses:` line for the full citation). Bumping the action
 * is a deliberate, reviewed act: update this constant in the SAME commit
 * that updates every reference (every `uses:` line AND every
 * hand-duplicated copy, such as a provenance env var string), so a
 * drifted/partial bump (one copy updated, another forgotten) fails this
 * check instead of silently shipping an inconsistent pin.
 */
export const EXPECTED_CLAUDE_CODE_ACTION_SHA =
  "700e7f8316990de46bed556429765647af760efc";

/**
 * Matches `anthropics/claude-code-action@<ref>` ANYWHERE it appears in a
 * line — deliberately not anchored to a `uses:` prefix (factory-security
 * review round 1, MEDIUM 2): `implement-ready-issues.yml` also carries a
 * hand-duplicated copy of the same SHA in an
 * `IMPLEMENT_AGENT_ACTION_REF: "anthropics/claude-code-action@<sha>"` env
 * var string (that file's own comment says "KEEP THESE TWO IN SYNC" —
 * exactly the kind of copy this drift-detection check exists to catch). A
 * `uses:`-anchored pattern would miss that copy entirely, so a future
 * bump that updated every real `uses:` line but forgot the env-var string
 * would pass this check green while a provenance trailer silently cited a
 * stale SHA. The ref itself is captured up to the first whitespace, quote,
 * or `#` — safe for both a bare YAML `uses:` value and a ref embedded
 * inside a quoted string. The ENTIRE ref token is captured and compared, so
 * a `@<sha>-main` / `@<sha>@v1` style mutable suffix tacked onto an
 * otherwise-correct SHA is caught rather than a `[0-9a-fA-F]{40}` alternative
 * stopping at the SHA boundary and silently accepting the suffix (Codex P2,
 * cid 3628037558).
 */
const ACTION_REFERENCE_PATTERN =
  /anthropics\/claude-code-action@([^\s"'#]+)/g;

/**
 * One violation of the pin/wildcard invariant, with enough context to act
 * on without re-reading the file.
 */
export interface WorkflowPinViolation {
  readonly kind: "unpinned-action" | "wildcard-allowlist";
  /** 1-based line number within the file's own text, for a direct jump. */
  readonly line: number;
  readonly detail: string;
}

/**
 * Finds every `anthropics/claude-code-action@<ref>` reference in a
 * workflow file's raw text that does NOT pin to
 * {@link EXPECTED_CLAUDE_CODE_ACTION_SHA} — whether that's a floating tag
 * (`@main`, `@v1`), a short SHA, a different full SHA (a drifted or
 * partial version bump), or a hand-duplicated copy outside any `uses:`
 * line (see {@link ACTION_REFERENCE_PATTERN}'s own docstring). A line can
 * contain more than one reference (loops via `matchAll` rather than a
 * single `exec`, so a second occurrence on the same line is never
 * silently skipped — not observed in this repo's current YAML style, but
 * cheap to not assume away).
 *
 * @param fileContent - The raw text of one `.github/workflows/*.yml` file.
 * @returns Every unpinned-action violation found, in file order.
 */
export function findUnpinnedActionReferences(
  fileContent: string,
): WorkflowPinViolation[] {
  const violations: WorkflowPinViolation[] = [];
  const lines = fileContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(ACTION_REFERENCE_PATTERN)) {
      if (match[1] !== EXPECTED_CLAUDE_CODE_ACTION_SHA) {
        violations.push({
          kind: "unpinned-action",
          line: i + 1,
          detail: `claude-code-action pinned to "${match[1]}", expected "${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
        });
      }
    }
  }
  return violations;
}

/**
 * The exact YAML keys this check treats as allowlist inputs — a bare `*`
 * on any of these would allowlist every actor/bot, defeating the point of
 * an allowlist. Deliberately narrow (not e.g. every quoted string) so this
 * check can't false-positive on an unrelated `*` appearing in a comment or
 * an unrelated field.
 */
const ALLOWLIST_KEYS = ["allowed_bots", "allowed_non_write_users"] as const;

/**
 * Strips a trailing YAML comment from a line, respecting quotes: a `#`
 * only starts a comment when it isn't inside a single- or double-quoted
 * scalar AND is preceded by whitespace or is the first character (YAML's
 * own rule for distinguishing a comment from a `#` that's part of an
 * unquoted scalar). Returns the line unchanged if no such `#` is found.
 *
 * @param line - One raw line from a workflow file.
 * @returns The line with any trailing comment removed.
 */
function stripYamlComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === "#" && !inSingleQuote && !inDoubleQuote) {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/**
 * Decodes the escape sequences a YAML DOUBLE-quoted scalar processes, enough
 * to compare the result against a literal wildcard. Every numeric encoding of
 * a character -- `\xHH`, `\uHHHH`, `\U########` -- is decoded, so `"\x2A"`,
 * `"*"`, and `"\U0000002A"` all resolve to the `*` they denote (the only
 * ways to write U+002A in a double-quoted scalar besides the literal). A `\\`
 * is consumed as one backslash FIRST, so an escaped backslash (`"\\x2A"`,
 * which YAML reads as the 4-char text `\x2A`, NOT `*`) can't be misread as the
 * start of a numeric escape. Any other `\<char>` keeps `<char>` verbatim --
 * none of YAML's named escapes can produce a bare `*`, so that coarse handling
 * is sufficient for this wildcard check. Single- and plain scalars do NOT
 * process backslash escapes in YAML, so this is applied ONLY to double-quoted
 * values (see {@link normalizeScalar}).
 */
function decodeDoubleQuotedScalar(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; ) {
    if (inner[i] !== "\\") {
      out += inner[i];
      i += 1;
      continue;
    }
    const next = inner[i + 1];
    if (next === "x" || next === "u" || next === "U") {
      const len = next === "x" ? 2 : next === "u" ? 4 : 8;
      const hex = inner.slice(i + 2, i + 2 + len);
      if (hex.length === len && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
    }
    // `\\` -> one backslash; any other `\<char>` -> keep <char> verbatim.
    if (next !== undefined) {
      out += next;
      i += 2;
    } else {
      out += "\\";
      i += 1;
    }
  }
  return out;
}

/**
 * Normalizes a YAML scalar for wildcard comparison: strips one layer of quotes
 * and, for a DOUBLE-quoted scalar, decodes its escape sequences (so `"\x2A"`
 * is recognized as the `*` it denotes -- Codex P2, cid 3628037563). A
 * single-quoted scalar is unquoted with YAML's only in-scalar escape (`''` ->
 * `'`); a plain scalar is returned as-is. Neither single nor plain scalars
 * process backslash escapes.
 */
function normalizeScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return decodeDoubleQuotedScalar(value.slice(1, -1));
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Finds every allowlist key in a workflow file's raw text whose value is a
 * bare wildcard (`*`) rather than an explicit list (or intentionally
 * empty) — in ANY of the three forms YAML allows a value to take.
 *
 * HARDENED (factory-security review round 1, MEDIUM 1 — the previous
 * version's end-anchored regex was bypassable two ways, both reproduced
 * by the reviewer and closed here):
 * 1. **A trailing comment defeated the end anchor**
 *    (`allowed_bots: '*' # deliberately wide`) — the regex required the
 *    wildcard to be the LAST thing on the line, so anything after it
 *    (including a comment meant to look innocuous) made the match fail.
 *    Fixed by stripping a trailing comment ({@link stripYamlComment})
 *    before testing the value.
 * 2. **The YAML block-list form was never checked at all**
 *    (`allowed_bots:` on one line, then `  - '*'` on the next) — a
 *    same-line-only regex can never see a value that lives on a
 *    different line. Fixed by detecting an empty-value key line and then
 *    scanning the list items that follow it.
 *
 * A YAML flow-sequence value (`allowed_bots: ['*']`) is also checked,
 * covering the third way YAML can express a one-element list on a single
 * line.
 *
 * 3. **A double-quoted numeric escape defeated the literal-`*` comparison**
 *    (`allowed_bots: "\x2A"`) — the previous quote-stripping helper compared
 *    the raw un-decoded text (`\x2A`), which never equals `*`, so this form
 *    slipped through even though YAML resolves it to the wildcard. Fixed by
 *    decoding double-quoted escape sequences before comparison (see
 *    {@link normalizeScalar}, Codex P2, cid 3628037563).
 *
 * @param fileContent - The raw text of one `.github/workflows/*.yml` file.
 * @returns Every wildcard-allowlist violation found, in file order.
 */
export function findWildcardAllowlistUsages(
  fileContent: string,
): WorkflowPinViolation[] {
  const violations: WorkflowPinViolation[] = [];
  const lines = fileContent.split("\n");
  const keyLinePattern = new RegExp(
    `^(\\s*)(${ALLOWLIST_KEYS.join("|")}):\\s*(.*)$`,
  );
  const listItemPattern = /^(\s*)-\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripYamlComment(lines[i]);
    const keyMatch = keyLinePattern.exec(stripped);
    if (!keyMatch) {
      continue;
    }
    const [, keyIndent, key, rawValue] = keyMatch;
    const value = rawValue.trim();

    if (value === "") {
      // Block-list form: the value lives on the following, more (or
      // equally) indented `- item` lines, not on this line at all.
      for (let j = i + 1; j < lines.length; j++) {
        const itemStripped = stripYamlComment(lines[j]);
        const itemMatch = listItemPattern.exec(itemStripped);
        if (!itemMatch || itemMatch[1].length < keyIndent.length) {
          break; // Dedent or non-list line: this key's list block ended.
        }
        if (normalizeScalar(itemMatch[2].trim()) === "*") {
          violations.push({
            kind: "wildcard-allowlist",
            line: j + 1,
            detail: `"${key}" has a "*" wildcard list entry — must be an explicit allowlist`,
          });
        }
      }
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      // Flow-sequence form: `key: ['*', 'other']`.
      const entries = value
        .slice(1, -1)
        .split(",")
        .map((entry) => normalizeScalar(entry.trim()));
      if (entries.includes("*")) {
        violations.push({
          kind: "wildcard-allowlist",
          line: i + 1,
          detail: `"${key}" has a "*" wildcard list entry — must be an explicit allowlist`,
        });
      }
      continue;
    }

    if (normalizeScalar(value) === "*") {
      violations.push({
        kind: "wildcard-allowlist",
        line: i + 1,
        detail: `"${key}" is a bare wildcard ("*") — must be an explicit allowlist`,
      });
    }
  }
  return violations;
}

/**
 * Runs both checks against one file's content.
 *
 * @param fileContent - The raw text of one `.github/workflows/*.yml` file.
 * @returns Every violation found by either check, in file order.
 */
export function findWorkflowPinViolations(
  fileContent: string,
): WorkflowPinViolation[] {
  return [
    ...findUnpinnedActionReferences(fileContent),
    ...findWildcardAllowlistUsages(fileContent),
  ].sort((a, b) => a.line - b.line);
}
