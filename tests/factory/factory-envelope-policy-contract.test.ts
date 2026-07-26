import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_PATCH_BYTES } from "../../scripts/factory/publish-implement-patch.mts";

const POLICY_SOURCES = [
  ["AGENTS.md", new URL("../../AGENTS.md", import.meta.url)],
  [
    "triage skill",
    new URL("../../.claude/skills/triage/SKILL.md", import.meta.url),
  ],
  [
    "decomposition skill",
    new URL("../../.claude/skills/to-issues/SKILL.md", import.meta.url),
  ],
  [
    "story template",
    new URL("../../.github/ISSUE_TEMPLATE/story.yml", import.meta.url),
  ],
  [
    "factory runbook",
    new URL("../../docs/factory-runbook.md", import.meta.url),
  ],
] as const;

describe("factory envelope policy consumers", () => {
  it("binds the documented artifact limit to the publisher boundary", () => {
    expect(MAX_PATCH_BYTES).toBe(2 * 1024 * 1024);
  });

  it.each(POLICY_SOURCES)(
    "%s exposes the universal textual and artifact caps",
    (_name, path) => {
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(
        /400 combined changed\s+textual lines across\s+(?:every|any) path\s+category/,
      );
      expect(content).toContain("2 MiB");
      expect(content).not.toContain("400 combined changed logic-and-test lines");
    },
  );
});
