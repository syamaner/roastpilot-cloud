/**
 * Pure logic behind the F1-S7 (issue #10) "no unpinned/wildcard
 * claude-code-action usage survives" regression check.
 *
 * S7.1's own AC calls for "a version/SHA check + a grep-based test" —
 * deliberately regex-based rather than a full YAML parse: the invariant
 * this guards is narrow and textual (every `claude-code-action@` usage
 * pins to the one reviewed-and-approved commit SHA; no `allowed_bots` /
 * `allowed_non_write_users` value is a bare `*` wildcard), and a real YAML
 * parse would need a new dependency for a check this simple. Nothing here
 * touches the filesystem — the caller (the test file) reads the actual
 * `.github/workflows/*.yml` files and passes their raw text in, so this
 * logic stays unit-testable against synthetic fixtures independent of the
 * real files.
 */

/**
 * The `claude-code-action` commit SHA every workflow file in this repo is
 * currently pinned to (`v1.0.176`, at/after the `v1.0.94`
 * bot-allowlist-bypass fix — see any of the workflow files' own comments
 * next to their `uses:` line for the full citation). Bumping the action
 * is a deliberate, reviewed act: update this constant in the SAME commit
 * that updates every `uses:` line, so a drifted/partial bump (one file
 * updated, another forgotten) fails this check instead of silently
 * shipping an inconsistent pin.
 */
export const EXPECTED_CLAUDE_CODE_ACTION_SHA =
  "700e7f8316990de46bed556429765647af760efc";

const ACTION_USES_PATTERN =
  /uses:\s*anthropics\/claude-code-action@([0-9a-fA-F]{40}|[^\s#]+)/g;

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
 * Finds every `anthropics/claude-code-action@<ref>` usage in a workflow
 * file's raw text that does NOT pin to
 * {@link EXPECTED_CLAUDE_CODE_ACTION_SHA} — whether that's a floating tag
 * (`@main`, `@v1`), a short SHA, or a different full SHA (a drifted or
 * partial version bump).
 *
 * @param fileContent - The raw text of one `.github/workflows/*.yml` file.
 * @returns Every unpinned-action violation found, in file order.
 */
export function findUnpinnedActionUsages(
  fileContent: string,
): WorkflowPinViolation[] {
  const violations: WorkflowPinViolation[] = [];
  const lines = fileContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ACTION_USES_PATTERN.lastIndex = 0;
    const match = ACTION_USES_PATTERN.exec(line);
    if (match && match[1] !== EXPECTED_CLAUDE_CODE_ACTION_SHA) {
      violations.push({
        kind: "unpinned-action",
        line: i + 1,
        detail: `claude-code-action pinned to "${match[1]}", expected "${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
      });
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
 * Finds every allowlist key in a workflow file's raw text whose value is a
 * bare wildcard (`*`, optionally quoted) rather than an explicit list (or
 * intentionally empty).
 *
 * @param fileContent - The raw text of one `.github/workflows/*.yml` file.
 * @returns Every wildcard-allowlist violation found, in file order.
 */
export function findWildcardAllowlistUsages(
  fileContent: string,
): WorkflowPinViolation[] {
  const violations: WorkflowPinViolation[] = [];
  const lines = fileContent.split("\n");
  const keyPattern = new RegExp(
    `^\\s*(${ALLOWLIST_KEYS.join("|")}):\\s*['"]?\\*['"]?\\s*$`,
  );
  for (let i = 0; i < lines.length; i++) {
    const match = keyPattern.exec(lines[i]);
    if (match) {
      violations.push({
        kind: "wildcard-allowlist",
        line: i + 1,
        detail: `"${match[1]}" is a bare wildcard ("*") — must be an explicit allowlist`,
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
    ...findUnpinnedActionUsages(fileContent),
    ...findWildcardAllowlistUsages(fileContent),
  ].sort((a, b) => a.line - b.line);
}
