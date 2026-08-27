import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sanitizeContractForPosting } from "../../scripts/factory/post-story-planner-contract.mts";
import { CODEX_TRIGGER_REMOVED_MARKER } from "../../scripts/factory/untrusted-text.mts";
import { expectNoLiveTrigger } from "./support/live-trigger-oracle";

const PUBLISHER_PATH = fileURLToPath(
  new URL("../../scripts/factory/post-story-planner-contract.mts", import.meta.url),
);

describe("story-planner contract posting sanitizer", () => {
  it("neutralizes raw, fullwidth, and invisible-separated Codex triggers", () => {
    const output = sanitizeContractForPosting(
      "@codex review\n＠codex review\n@\u200Bcodex review",
    );

    expectNoLiveTrigger(output);
    expect(output.match(/\[codex trigger removed\]/g)).toHaveLength(2);
    expect(output).toContain(CODEX_TRIGGER_REMOVED_MARKER);
    expect(output).toContain("@[U+200B]codex review");
  });

  it.each([
    ["single opening backtick", "@`codex review"],
    ["backtick-wrapped name", "@`codex` review"],
    ["multiple opening backticks", "@``codex review"],
    ["space then backtick", "@ `codex review"],
    ["backtick then space", "@` codex review"],
    ["backtick-space-backtick", "@` `codex review"],
    ["tab then backtick", "@\t`codex review"],
    ["backtick then newline", "@`\ncodex review"],
    ["fullwidth and NFKC-folded trigger", "＠`ｃodex review"],
  ])("neutralizes the proven backtick-split trigger: %s", (_label, input) => {
    const output = sanitizeContractForPosting(input);

    expect(output).toContain(CODEX_TRIGGER_REMOVED_MARKER);
    expect(output).not.toContain("@`codex");
    expect(output).not.toContain("@``codex");
    expectNoLiveTrigger(output);
  });

  it("preserves issue-comment CI-skip literals while neutralizing a Codex trigger", () => {
    const input = [
      "Document [skip ci], [ci skip], and skip-checks: true exactly.",
      "@codex review",
    ].join("\n");
    const output = sanitizeContractForPosting(input);

    expect(output).toBe(
      `Document [skip ci], [ci skip], and skip-checks: true exactly.\n${CODEX_TRIGGER_REMOVED_MARKER} review`,
    );
  });

  it("returns legitimate Markdown byte-unchanged", () => {
    const markdown = [
      "# Plan",
      "",
      "- Keep **rendered Markdown** intact.",
      "",
      "`npm test`",
      "",
      "```sh",
      "npm test",
      "```",
      "",
    ].join("\n");
    expect(sanitizeContractForPosting(markdown)).toBe(markdown);
  });

  it("routes the posted contract body through the sanitizer", () => {
    const source = readFileSync(PUBLISHER_PATH, "utf8");
    expect(source).toContain("sanitizeContractForPosting(contract) +");
    expect(source).toContain('"\\n" +');
    expect(source).toContain("STORY_PLANNER_CONTRACT_MARKER(issueNumber)");
  });
});
