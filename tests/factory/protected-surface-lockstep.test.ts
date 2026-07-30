import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROTECTED_BASENAMES,
  PROTECTED_EXACT_PATHS,
  PROTECTED_PATH_PREFIXES,
} from "../../scripts/factory/implement-patch-logic.mts";

/**
 * The lockstep control (#160). CODEOWNERS's header has always CLAIMED it
 * mirrors the factory patch guard's PROTECTED_PATH_PREFIXES /
 * PROTECTED_EXACT_PATHS "exactly" and asked a human to keep them in step.
 * Nothing enforced it, and the claim was false — `.claude/` wholesale,
 * `.codex/`, `AGENTS.md`, and `docs/state/registry.md` were all unmirrored.
 * This test turns the plea into a mechanical check, byte-for-byte, so a path
 * added to one list without the other reddens CI.
 *
 * The comparison is deliberately byte-exact, NOT GitHub's own glob matcher: a
 * mirror this test blesses must be one a human can read off the two lists
 * literally, not one that happens to be equivalent under CODEOWNERS pattern
 * semantics. Over-strictness is the safe direction here — it can only demand a
 * more obvious mirror, never bless a subtler one.
 *
 * `require_code_owner_reviews` is OFF on `main` today (#160/#163), so these
 * CODEOWNERS rules are forward-looking documentation and the guard is the sole
 * mechanical control. This test protects the DOCUMENTATION's honesty so it is
 * correct the moment required reviews are switched on.
 *
 * OWNERSHIP is fully checked offline (codex P2): Direction B requires every rule
 * to be owned EXCLUSIVELY by `@syamaner`, so an extra co-owner
 * (`@syamaner @other`) or a subpath rule delegating a protected path to a
 * different owner is rejected here, not merely documented.
 *
 * PARSER LIMITS that remain (documentation-severity while required reviews are
 * OFF; qa Gap-3 note for the PR body). This is a byte-level lockstep check, NOT
 * a full GitHub CODEOWNERS validator: it does not confirm `@syamaner` EXISTS or
 * can be requested as a reviewer (offline, no API), and it does not
 * GitHub-faithfully reject every malformed line — a mid-line `#` (GitHub treats
 * the rest as a comment) is parsed literally here. Neither can mis-BLESS a
 * drifted mirror (a wrong/extra owner or missing rule still fails), only fail to
 * diagnose an already-malformed file, so they are acceptable until required
 * reviews make CODEOWNERS load-bearing.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** One parsed CODEOWNERS rule: the pattern and the owners that follow it. */
interface CodeownersRule {
  readonly path: string;
  readonly owners: readonly string[];
}

/**
 * The guard lists this control mirrors. Direction A mirrors `prefixes` +
 * `exactPaths` into CODEOWNERS byte-for-byte; `basenames` are deliberately NOT
 * mirrored (guard-only depth defence) but ARE part of the guard's protected
 * surface, so Direction B counts a rule pointing at a basename-protected path
 * as legitimately owned.
 */
interface GuardLists {
  readonly prefixes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly basenames: readonly string[];
}

/**
 * Parses CODEOWNERS text into rules. Comments (`#...`) and blank lines are
 * dropped; every other line is `<pattern> <owner>...`. No glob interpretation
 * — the pattern is kept as the literal bytes written. See the file header for
 * the parser's documented limits.
 */
export function parseCodeownersRules(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [path, ...owners] = line.split(/\s+/);
    rules.push({ path, owners });
  }
  return rules;
}

/** The one principal every protected surface must resolve to, exclusively. */
const SOLE_OWNER = "@syamaner";

/**
 * Whether a rule's owner list is EXACTLY `[SOLE_OWNER]` — one owner, and that
 * owner is `@syamaner`. Not `.includes`: an extra owner (`@syamaner @other`)
 * would let `@other` satisfy a required code-owner review, and a subpath rule
 * delegating to a different owner would hand GitHub's last-match resolution to
 * that owner (codex P2). Both are exclusivity failures this catches. This is
 * offline-verifiable (it reads only the rule's own tokens); owner-EXISTENCE is
 * not, and stays documented-only in the file header.
 */
function isSoleOwner(owners: readonly string[]): boolean {
  return owners.length === 1 && owners[0] === SOLE_OWNER;
}

/** Strips exactly one leading `/` so a rule path can be checked as repo-relative. */
function toRepoRelative(rulePath: string): string {
  return rulePath.replace(/^\//, "");
}

/**
 * Whether a repo-relative path is covered by the PASSED guard lists — an exact
 * match, a basename match, or a prefix match. This mirrors the guard's own
 * `isProtectedPath` matching core, but reads ONLY from the `guard` argument
 * rather than the live imported guard, so {@link findLockstepViolations} is
 * genuinely pure over its inputs and the injected N4 fixtures test what they
 * claim (qa Gap-2). It deliberately omits the guard's `..`/absolute fail-closed
 * branch: CODEOWNERS rule paths are anchored patterns, never traversal strings,
 * so after {@link toRepoRelative} there is nothing to fail closed on.
 */
function isCoveredByGuard(guard: GuardLists, repoRelativePath: string): boolean {
  if (guard.exactPaths.includes(repoRelativePath)) {
    return true;
  }
  const basename = repoRelativePath.slice(repoRelativePath.lastIndexOf("/") + 1);
  if (guard.basenames.includes(basename)) {
    return true;
  }
  return guard.prefixes.some((prefix) => repoRelativePath.startsWith(prefix));
}

/**
 * The pure core (fixture-injectable, #160): reports every way CODEOWNERS and
 * the guard lists fail to mirror each other. Empty means the mirror holds.
 *
 * Direction A — every guard prefix `p` and exact path `x` has a BYTE-IDENTICAL
 * `/p` / `/x` rule owned EXACTLY by `@syamaner`. The check finds the LAST
 * matching rule, not the first: GitHub honours the LAST matching CODEOWNERS
 * pattern, so a later rule for the same path with a different owner is what
 * actually governs, and a first-match model would bless a file GitHub resolves
 * to a different owner. A missing rule and a present-but-wrong-owner rule are
 * reported distinctly.
 *
 * Direction B — every CODEOWNERS rule must (i) point at a guard-protected path,
 * checked against the PASSED guard via {@link isCoveredByGuard}, AND (ii) be
 * owned EXCLUSIVELY by `@syamaner` (see {@link isSoleOwner}). (i) stops
 * CODEOWNERS drifting to own paths the guard would let a factory patch touch;
 * (ii) closes the ownership axis (codex P2): a subpath rule delegating a
 * protected path to a different owner, or a rule adding a co-owner alongside
 * `@syamaner`, both have guard-protected paths yet hand effective ownership to
 * someone other than the sole operator, so a path-only check would bless them.
 */
export function findLockstepViolations(
  guard: GuardLists,
  rules: readonly CodeownersRule[],
): string[] {
  const violations: string[] = [];

  const requireMirror = (expectedPath: string, kind: string): void => {
    // Last-match-wins, mirroring GitHub's CODEOWNERS precedence.
    const rule = rules.findLast((candidate) => candidate.path === expectedPath);
    if (rule === undefined) {
      violations.push(`missing CODEOWNERS rule for guard ${kind} (expected \`${expectedPath}\`)`);
      return;
    }
    if (!isSoleOwner(rule.owners)) {
      violations.push(`CODEOWNERS rule \`${expectedPath}\` must be owned by @syamaner`);
    }
  };

  // Direction A.
  for (const prefix of guard.prefixes) {
    requireMirror(`/${prefix}`, `prefix \`${prefix}\``);
  }
  for (const exactPath of guard.exactPaths) {
    requireMirror(`/${exactPath}`, `exact path \`${exactPath}\``);
  }

  // Direction B.
  for (const rule of rules) {
    if (!isCoveredByGuard(guard, toRepoRelative(rule.path))) {
      violations.push(`CODEOWNERS rule \`${rule.path}\` is not a guard-protected path`);
    }
    if (!isSoleOwner(rule.owners)) {
      violations.push(`CODEOWNERS rule \`${rule.path}\` must be owned exclusively by @syamaner`);
    }
  }

  return violations;
}

describe("protected-surface lockstep (guard <-> CODEOWNERS, #160)", () => {
  const realGuard: GuardLists = {
    prefixes: [...PROTECTED_PATH_PREFIXES],
    exactPaths: [...PROTECTED_EXACT_PATHS],
    basenames: [...PROTECTED_BASENAMES],
  };
  const realRules = parseCodeownersRules(
    readFileSync(fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)), "utf8"),
  );

  // Non-vacuous guard: the parse must yield at least one rule per guard entry,
  // kept separate so it never short-circuits the lockstep check below (a
  // dropped rule must be caught by the direction-A violation, not only here).
  it("parses a non-vacuous rule set from the live CODEOWNERS", () => {
    expect(realRules.length).toBeGreaterThanOrEqual(
      PROTECTED_PATH_PREFIXES.length + PROTECTED_EXACT_PATHS.length,
    );
  });

  // T5: A+B hold on the real tree.
  it("mirrors the live guard lists in the live CODEOWNERS, both directions", () => {
    expect(findLockstepViolations(realGuard, realRules)).toEqual([]);
  });

  // T6 + root-shadow absence: the only CODEOWNERS location that outranks the
  // repo-root file must not exist, or every rule above would be silently
  // shadowed with no error from GitHub (the precedence hazard in the header).
  it("has no higher-precedence .github/CODEOWNERS shadowing the root file", () => {
    expect(existsSync(`${REPOSITORY_ROOT}.github/CODEOWNERS`)).toBe(false);
  });

  it("has no stray docs/CODEOWNERS file drifting from the owned path", () => {
    // Owned pre-emptively above, but nothing should actually live there today.
    expect(existsSync(`${REPOSITORY_ROOT}docs/CODEOWNERS`)).toBe(false);
  });

  // N4: the pure core reports each drift kind, proven against injected
  // fixtures rather than the real (passing) tree.
  describe("findLockstepViolations reports each drift (N4)", () => {
    const guard: GuardLists = {
      prefixes: [".github/", "tests/factory/"],
      exactPaths: ["AGENTS.md"],
      basenames: [],
    };
    const completeMirror: CodeownersRule[] = [
      { path: "/.github/", owners: ["@syamaner"] },
      { path: "/tests/factory/", owners: ["@syamaner"] },
      { path: "/AGENTS.md", owners: ["@syamaner"] },
    ];

    it("passes on a complete, correctly-owned mirror", () => {
      expect(findLockstepViolations(guard, completeMirror)).toEqual([]);
    });

    it("honours the LAST matching rule (GitHub precedence), not the first", () => {
      // A well-owned rule, then a later shadowing rule for the same path owned
      // by someone else — GitHub resolves the path to @other, so the mirror is
      // NOT intact. A first-match check would wrongly bless it.
      const shadowed: CodeownersRule[] = [
        ...completeMirror,
        { path: "/AGENTS.md", owners: ["@other"] },
      ];
      expect(findLockstepViolations(guard, shadowed)).toContainEqual(
        expect.stringContaining("`/AGENTS.md` must be owned by @syamaner"),
      );
    });

    it("flags a guard path with no CODEOWNERS rule", () => {
      const missing = completeMirror.filter((rule) => rule.path !== "/tests/factory/");
      expect(findLockstepViolations(guard, missing)).toContainEqual(
        expect.stringContaining("missing CODEOWNERS rule for guard prefix `tests/factory/`"),
      );
    });

    it("flags a mirrored rule owned by the wrong principal", () => {
      const wrongOwner = completeMirror.map((rule) =>
        rule.path === "/AGENTS.md" ? { path: rule.path, owners: ["@someone-else"] } : rule,
      );
      expect(findLockstepViolations(guard, wrongOwner)).toContainEqual(
        expect.stringContaining("`/AGENTS.md` must be owned by @syamaner"),
      );
    });

    it("flags a CODEOWNERS rule that owns a non-guard-protected path", () => {
      const strayRule: CodeownersRule[] = [
        ...completeMirror,
        { path: "/lib/slug.ts", owners: ["@syamaner"] },
      ];
      expect(findLockstepViolations(guard, strayRule)).toContainEqual(
        expect.stringContaining("`/lib/slug.ts` is not a guard-protected path"),
      );
    });

    // Exclusive-ownership (codex P2): a rule can have a guard-protected PATH yet
    // still hand GitHub's effective ownership to someone other than @syamaner.
    it("flags a subpath rule delegating a protected path to a different owner", () => {
      // `/tests/factory/ @syamaner` is intact, but a later, MORE-specific
      // subpath rule makes GitHub resolve foo.test.ts to @other by last-match.
      const subpathOverride: CodeownersRule[] = [
        ...completeMirror,
        { path: "/tests/factory/foo.test.ts", owners: ["@other"] },
      ];
      expect(findLockstepViolations(guard, subpathOverride)).toContainEqual(
        expect.stringContaining(
          "`/tests/factory/foo.test.ts` must be owned exclusively by @syamaner",
        ),
      );
    });

    it("flags a rule that adds a co-owner alongside @syamaner", () => {
      // `owners.includes("@syamaner")` would pass this; @other could then
      // satisfy a required code-owner review.
      const extraOwner = completeMirror.map((rule) =>
        rule.path === "/AGENTS.md"
          ? { path: rule.path, owners: ["@syamaner", "@other"] }
          : rule,
      );
      expect(findLockstepViolations(guard, extraOwner)).toContainEqual(
        expect.stringContaining("`/AGENTS.md` must be owned exclusively by @syamaner"),
      );
    });

    it("judges Direction B against the PASSED guard, not the live guard", () => {
      // `/.claude/` IS protected by the real imported guard, but this narrow
      // synthetic guard does not cover it, so a rule owning it must be flagged.
      // Were Direction B still reading the live `isProtectedPath`, `.claude/`
      // would count as protected and this would NOT fire — so this pins the
      // parametricity fix (qa Gap-2).
      const narrowGuard: GuardLists = {
        prefixes: [".github/"],
        exactPaths: [],
        basenames: [],
      };
      expect(
        findLockstepViolations(narrowGuard, [
          { path: "/.claude/", owners: ["@syamaner"] },
        ]),
      ).toContainEqual(
        expect.stringContaining("`/.claude/` is not a guard-protected path"),
      );
    });
  });
});
