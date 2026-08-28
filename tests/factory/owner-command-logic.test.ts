import { describe, expect, it } from "vitest";

import {
  isFactoryOwnerLogin,
} from "../../scripts/factory/factory-owner-allowlist.mts";
import {
  isEligibleFactoryOwnerAuthor,
  isEligiblePullRequestState,
  isPullRequestIssue,
  isSameRepositoryPullRequest,
  MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS,
  parseOwnerCommand,
} from "../../scripts/factory/owner-command-logic.mts";

describe("owner-command grammar", () => {
  it("G-V1 / P-lead-question parses a leading question", () => {
    expect(parseOwnerCommand("@claude question why?")).toEqual({
      verb: "question",
      payload: " why?",
      truncated: false,
    });
  });

  it("G-V2 / P-lead-task parses a leading task", () => {
    expect(parseOwnerCommand("@claude task fix")).toEqual({
      verb: "task",
      payload: " fix",
      truncated: false,
    });
  });

  it.each([
    ["@claude approve", "approve"],
    ["@claude respec", "respec"],
  ] as const)("M-PARSE parses the issue verb in %s", (body, verb) => {
    expect(parseOwnerCommand(body)).toEqual({
      verb,
      payload: "",
      truncated: false,
    });
  });

  it("G-V3 rejects a verb outside the closed set", () => {
    expect(parseOwnerCommand("@claude review x")).toBeNull();
  });

  it("M-PARSE keeps an unknown deploy verb inert", () => {
    expect(parseOwnerCommand("@claude deploy x")).toBeNull();
  });

  it.each([
    "prose @claude approve",
    "context\n@claude respec",
    "> @claude approve",
  ])("M-LEAD rejects non-leading issue command placement in %j", (body) => {
    expect(parseOwnerCommand(body)).toBeNull();
  });

  it.each(["@claude questions", "@claude question2"])(
    "G-V4 rejects a non-boundary verb in %s",
    (body) => expect(parseOwnerCommand(body)).toBeNull(),
  );

  it.each(["@claude quesтion", "@claude ques\u200btion"])(
    "G-V5 rejects non-ASCII or invisible characters in %s",
    (body) => expect(parseOwnerCommand(body)).toBeNull(),
  );

  it.each([
    ["@claude QUESTION", "question"],
    ["@Claude Question", "question"],
  ] as const)("G-C1 ASCII-case-folds %s", (body, verb) => {
    expect(parseOwnerCommand(body)).toEqual({
      verb,
      payload: "",
      truncated: false,
    });
  });

  it.each([
    ["@CLAUDE APPROVE", "approve"],
    ["@Claude\tReSpEc\tpayload", "respec"],
    ["\n\n@claude   approve body", "approve"],
  ] as const)("M-PARSE ASCII-folds and accepts hardened whitespace in %j", (body, verb) => {
    expect(parseOwnerCommand(body)).toEqual({
      verb,
      payload: body.endsWith("payload")
        ? "\tpayload"
        : body.endsWith("body") ? " body" : "",
      truncated: false,
    });
  });

  it("G-C2 rejects a fullwidth verb", () => {
    expect(parseOwnerCommand("@claude ＱUESTION")).toBeNull();
  });

  it("G-F1 treats every later marker as inert payload data", () => {
    expect(parseOwnerCommand("@claude question A\n@claude task B")).toEqual({
      verb: "question",
      payload: " A\n@claude task B",
      truncated: false,
    });
    expect(parseOwnerCommand("@claude question A\r\n@claude task B")).toEqual({
      verb: "question",
      payload: " A\n@claude task B",
      truncated: false,
    });
    expect(parseOwnerCommand("@claude question A @claude task B")).toEqual({
      verb: "question",
      payload: " A @claude task B",
      truncated: false,
    });
  });

  it("G-F2 lets an invalid first marker decide without fall-through", () => {
    expect(parseOwnerCommand(
      "@claude frobnicate\n@claude question A",
    )).toBeNull();
  });

  it("G-F3 rejects prose after a fenced first marker", () => {
    expect(parseOwnerCommand(
      "```text\n@claude task fenced\n```\n@claude question prose",
    )).toBeNull();
  });

  it("G-Q1 rejects a command only inside a backtick fence", () => {
    expect(parseOwnerCommand("```\n@claude question x\n```"))
      .toBeNull();
  });

  it("G-Q2 rejects a blockquote command", () => {
    expect(parseOwnerCommand("> @claude task x")).toBeNull();
  });

  it("G-Q3 rejects a lazy blockquote continuation command", () => {
    expect(parseOwnerCommand("> quoted\n@claude task x")).toBeNull();
  });

  it("G-Q4 rejects an inline-code command", () => {
    expect(parseOwnerCommand("`@claude question x`")).toBeNull();
  });

  it.each([
    "~~~\n@claude task x\n~~~",
    "```\n@claude task x",
    "    @claude task x",
    "<!-- @claude task x -->",
  ])("G-Q5 rejects every protected Markdown form in %j", (body) => {
    expect(parseOwnerCommand(body)).toBeNull();
  });

  it("G-Q7 rejects non-leading CR/LF fence and blockquote commands", () => {
    for (const body of [
      "ctx\r```\n@claude task PWN\n```",
      "ctx\r\n```\n@claude task PWN\n```",
      "ctx\n```\n@claude task PWN\n```",
      "ctx\r> @claude task PWN",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("P-crlf-lead normalizes a leading command payload", () => {
    expect(parseOwnerCommand("@claude question x\r\n more")).toEqual({
      verb: "question",
      payload: " x\n more",
      truncated: false,
    });
  });

  it("G-Q8 rejects astral-prefixed fence and blockquote commands", () => {
    for (const body of [
      "😀".repeat(20) + "\n```\n@claude task PWN\n```",
      "😀".repeat(16) + "\n```\n@claude task PWN\n```",
      `${"😀".repeat(20)}\n> @claude task PWN`,
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("G-Q9 rejects commands after terminated and unterminated HTML comments", () => {
    for (const body of [
      "<!--\n@claude task hidden",
      "x <!-- @claude task hidden",
      "<!-- @claude task hidden -->",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("G-Q10 rejects every backslash parity before terminated and EOF comments", () => {
    for (let backslashCount = 0; backslashCount <= 4; backslashCount++) {
      const prefix = "\\".repeat(backslashCount);
      expect(parseOwnerCommand(
        `${prefix}<!-- @claude task EVIL -->`,
      )).toBeNull();
      expect(parseOwnerCommand(
        `${prefix}<!-- @claude task EVIL`,
      )).toBeNull();
    }
    expect(parseOwnerCommand(
      `${"\\".repeat(2)}<!-- hidden --> @claude question real`,
    )).toBeNull();
  });

  it("G-Q11 rejects raw-HTML and formatting before a command", () => {
    for (const body of [
      "<blockquote>\n@claude task PWN\n</blockquote>",
      "<pre>\n@claude task x\n</pre>",
      "<code>@claude task x</code>",
      "<details>\n@claude task x\n</details>",
      ...["code", "kbd", "pre", "samp", "tt"].map(
        (tag) => `prefix <${tag}> @claude task x</${tag}>`,
      ),
      "prefix <code><kbd> @claude task x</code></kbd>",
      "<code> @claude task x",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
    for (const body of [
      "<br> @claude question real",
      "<br/> @claude question real",
      "<b>hi</b> @claude question real",
      "</code> @claude question real",
      "```\n<!--\n```\n@claude question real",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("G-Q6 rejects a body over the 256 KiB structural cap", () => {
    expect(parseOwnerCommand(
      `@claude task ${"x".repeat(256 * 1024)}`,
    )).toBeNull();
  });

  it("rejects markers without the exact ASCII marker and token boundaries", () => {
    for (const body of [
      "x@claude task x",
      "＠claude task x",
      "@claude\u200b task x",
      "@claude\u00a0task x",
      "@claude question\u200b x",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
    expect(parseOwnerCommand("prose\t@CLAUDE\ttask\twork")).toBeNull();
  });

  it("rejects an ambiguous inline-code span before a marker", () => {
    expect(parseOwnerCommand("`` `x` `` @claude task hidden"))
      .toBeNull();
  });

  it("N-details-seam rejects a command after a details blank-line seam", () => {
    expect(parseOwnerCommand(
      "<details>\n\n@claude task PWN\n</details>",
    )).toBeNull();
  });

  it("N-details-summary rejects a command after a details summary seam", () => {
    expect(parseOwnerCommand(
      "<details>\n<summary>logs</summary>\n\n@claude task PWN\n</details>",
    )).toBeNull();
  });

  it("N-blockquote-seam rejects a command after a raw blockquote seam", () => {
    expect(parseOwnerCommand(
      "<blockquote>\n\n@claude task PWN\n</blockquote>",
    )).toBeNull();
  });

  it("N-md-blockquote-seam rejects a command after a Markdown quote", () => {
    expect(parseOwnerCommand("> ctx\n\n@claude task PWN")).toBeNull();
  });

  it.each([
    "<sub>@claude task x</sub>",
    "<kbd>@claude task x</kbd>",
  ])("N-inline-hidden rejects %s", (body) => {
    expect(parseOwnerCommand(body)).toBeNull();
  });

  it("N-link-dest rejects a marker in a link destination", () => {
    expect(parseOwnerCommand("[x](<url @claude task hidden>)")).toBeNull();
  });

  it("N-ref-def rejects a marker in a link reference definition", () => {
    expect(parseOwnerCommand("[ref]: <url @claude task hidden>")).toBeNull();
  });

  it("N-ambiguous-span rejects a marker in a raw anchor", () => {
    expect(parseOwnerCommand('<a href="#">@claude task x</a>')).toBeNull();
  });

  it.each([
    "\u2028@claude task x",
    "\u2029@claude task x",
    "\ufeff@claude task x",
    "\u200b@claude question x",
  ])("N-unicode-lead rejects %j", (body) => {
    expect(parseOwnerCommand(body)).toBeNull();
  });

  it.each([
    "   @claude task x",
    "    @claude task x",
  ])("N-indent-space rejects %j", (body) => {
    expect(parseOwnerCommand(body)).toBeNull();
  });

  it("N-indent-tab rejects a tab-indented command", () => {
    expect(parseOwnerCommand("\t@claude task x")).toBeNull();
  });

  it("N-ws-line-lead rejects a whitespace-only first line", () => {
    expect(parseOwnerCommand(" \n@claude task x")).toBeNull();
  });

  it("P-lead-blanklines accepts only a leading run of blank LF lines", () => {
    expect(parseOwnerCommand("\n\n@claude question x")).toEqual({
      verb: "question",
      payload: " x",
      truncated: false,
    });
  });

  it("P-question-then-logs retains the complete visible command tail", () => {
    const payload = " why did CI fail?\n\n<details>\n<summary>logs</summary>\n\n(log body)\n</details>";
    expect(parseOwnerCommand(`@claude question${payload}`)).toEqual({
      verb: "question",
      payload,
      truncated: false,
    });
  });

  it("G1 leading-position rejects scan-anywhere container seams", () => {
    expect(parseOwnerCommand(
      "<details>\n\n@claude task PWN\n</details>",
    )).toBeNull();
    expect(parseOwnerCommand("> ctx\n\n@claude task PWN")).toBeNull();
  });

  it("G2 no-leading-indent rejects space and tab trimming", () => {
    for (const body of [
      "   @claude task x",
      "    @claude task x",
      "\t@claude task x",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("G3 strip-only-LF rejects broader whitespace stripping", () => {
    for (const body of [
      "\u2028@claude task x",
      "\ufeff@claude task x",
      " \n@claude task x",
    ]) {
      expect(parseOwnerCommand(body)).toBeNull();
    }
  });

  it("G8 keep normalizeLineEndings preserves the normalized CRLF payload", () => {
    expect(parseOwnerCommand("@claude question x\r\n more")).toEqual({
      verb: "question",
      payload: " x\n more",
      truncated: false,
    });
  });
});

describe("owner-command eligibility", () => {
  it("G-A1 accepts only the exact owner in both predicates", () => {
    expect(isFactoryOwnerLogin("syamaner")).toBe(true);
    expect(isEligibleFactoryOwnerAuthor({ login: "syamaner" })).toBe(true);
  });

  it("G-A2 rejects another login", () => {
    expect(isFactoryOwnerLogin("other")).toBe(false);
    expect(isEligibleFactoryOwnerAuthor({ login: "other" })).toBe(false);
  });

  it.each(["Syamaner", "SYAMANER"])(
    "G-A3 rejects case variant %s",
    (login) => {
      expect(isFactoryOwnerLogin(login)).toBe(false);
      expect(isEligibleFactoryOwnerAuthor({ login })).toBe(false);
    },
  );

  it.each([
    "syamaner ",
    " syamaner",
    "syamaner[bot]",
    "syamanerx",
    "xsyamaner",
  ])("G-A4 rejects byte variant %j", (login) => {
    expect(isFactoryOwnerLogin(login)).toBe(false);
    expect(isEligibleFactoryOwnerAuthor({ login })).toBe(false);
  });

  it.each(["syamаner", "sy\u200bamaner"])(
    "G-A5 rejects homoglyph or invisible variant %j",
    (login) => {
      expect(isFactoryOwnerLogin(login)).toBe(false);
      expect(isEligibleFactoryOwnerAuthor({ login })).toBe(false);
    },
  );

  it.each([null, undefined, 7, {}])(
    "G-A6 rejects non-string login %j",
    (login) => {
      expect(isFactoryOwnerLogin(login)).toBe(false);
      expect(isEligibleFactoryOwnerAuthor(login)).toBe(false);
      expect(isEligibleFactoryOwnerAuthor({ login })).toBe(false);
    },
  );

  it("G-K1 excludes a fork by exact full-name bytes", () => {
    expect(isSameRepositoryPullRequest(
      { head: { repo: { full_name: "fork/roastpilot-cloud" } } },
      "syamaner/roastpilot-cloud",
    )).toBe(false);
    expect(isSameRepositoryPullRequest(
      { head: { repo: { full_name: "syamaner/roastpilot-cloud" } } },
      "syamaner/roastpilot-cloud",
    )).toBe(true);
  });

  it.each([
    { head: { repo: null } },
    { head: {} },
    {},
    null,
  ])("G-K2 excludes null or absent head.repo in %j", (pullRequest) => {
    expect(isSameRepositoryPullRequest(
      pullRequest,
      "syamaner/roastpilot-cloud",
    )).toBe(false);
  });

  it.each([
    { state: "open", merged: false, draft: false },
    { state: "open", merged: false, draft: true },
  ])("G-S0 admits open unmerged PR %#", (pullRequest) => {
    expect(isEligiblePullRequestState(pullRequest)).toBe(true);
  });

  it.each([
    { state: "closed", merged: false },
    { state: "open", merged: true },
    { state: "open" },
    null,
  ])("G-S1 rejects closed, merged, or malformed PR %j", (pullRequest) => {
    expect(isEligiblePullRequestState(pullRequest)).toBe(false);
  });

  it("G-S2 excludes a comment issue without pull_request", () => {
    expect(isPullRequestIssue({})).toBe(false);
    expect(isPullRequestIssue(null)).toBe(false);
    expect(isPullRequestIssue({ pull_request: null })).toBe(false);
    expect(isPullRequestIssue({ pull_request: {} })).toBe(true);
  });
});

describe("owner-command payload", () => {
  it("P-B1 slices payload code blocks from the original body", () => {
    const body = "@claude question explain\n```ts\n@claude task example\n```";
    expect(parseOwnerCommand(body)).toEqual({
      verb: "question",
      payload: " explain\n```ts\n@claude task example\n```",
      truncated: false,
    });
  });

  it("P-B2 bounds payload by Unicode code points without splitting one", () => {
    const payload = `${"a".repeat(MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS - 2)}😀tail`;
    const parsed = parseOwnerCommand(`@claude task ${payload}`);
    expect(parsed?.payload).toBe(
      ` ${"a".repeat(MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS - 2)}😀`,
    );
    expect([...(parsed?.payload ?? "")]).toHaveLength(
      MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS,
    );
    expect(parsed?.truncated).toBe(true);
    expect(parseOwnerCommand("@claude task normal")?.truncated).toBe(false);
    expect(parseOwnerCommand(
      `@claude task ${"x".repeat(MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS - 1)}`,
    )?.truncated).toBe(false);
  });

});
