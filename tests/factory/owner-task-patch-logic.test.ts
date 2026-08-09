import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { FactoryPatchLineStat } from
  "../../scripts/factory/implement-patch-logic.mts";
import { FACTORY_OWNER_LOGINS } from
  "../../scripts/factory/factory-owner-allowlist.mts";
import {
  decideOwnerTaskPatch,
  buildTaskApplyMarker,
  buildTaskTrailer,
  findTaskTrailerCommit,
  hasExistingTaskApply,
  neutralizeTaskMarkers,
  parseTaskBinding,
  type OwnerTaskPatchDecisionInput,
  type TaskBinding,
} from "../../scripts/factory/owner-task-patch-logic.mts";
import { MAX_PATCH_BYTES } from
  "../../scripts/factory/publish-implement-patch.mts";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const ADVANCED_HEAD_SHA = "3".repeat(40);
const TREE_OID = "4".repeat(40);
const ADVANCED_BASE_SHA = "5".repeat(40);
const PAYLOAD = " update the implementation";
const BOT_LOGIN = "github-actions[bot]";
const REPOSITORY = "owner/repository";
const OWNER_LOGIN = FACTORY_OWNER_LOGINS.values().next().value;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function binding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    version: 1,
    kind: "owner-task",
    prHeadSha: HEAD_SHA,
    prBaseSha: BASE_SHA,
    commandPayloadSha256: sha256(PAYLOAD),
    taskTruncated: false,
    ...overrides,
  };
}

function lineStat(
  path = "lib/change.ts",
  overrides: Partial<FactoryPatchLineStat> = {},
): FactoryPatchLineStat {
  return { path, additions: 1, deletions: 0, ...overrides };
}

function decisionInput(
  overrides: Partial<OwnerTaskPatchDecisionInput> = {},
): OwnerTaskPatchDecisionInput {
  return {
    issue: { pull_request: {} },
    pullRequest: {
      head: {
        sha: HEAD_SHA,
        repo: { full_name: REPOSITORY },
      },
      base: { sha: BASE_SHA },
      state: "open",
      merged: false,
    },
    author: { login: OWNER_LOGIN },
    commentBody: `@claude task${PAYLOAD}`,
    githubRepository: REPOSITORY,
    commentId: 73,
    bindingArtifact: JSON.stringify(binding()),
    markerPresent: false,
    trailerCommitPresent: false,
    patchArtifactBytes: 100,
    patchAnalysis: {
      status: "ok",
      analysis: {
        baseSha: HEAD_SHA,
        treeOid: TREE_OID,
        changedPaths: ["lib/change.ts"],
        diffText: "",
        lineStats: [lineStat()],
      },
    },
    ...overrides,
  };
}

function pullRequest(overrides: {
  headSha?: unknown;
  baseSha?: unknown;
  repository?: string;
  state?: string;
  merged?: boolean;
} = {}) {
  return {
    head: {
      sha: overrides.headSha ?? HEAD_SHA,
      repo: { full_name: overrides.repository ?? REPOSITORY },
    },
    base: { sha: overrides.baseSha ?? BASE_SHA },
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
  };
}

describe("owner-task binding grammar", () => {
  it("T6: round-trips the exact closed version-1 owner-task binding", () => {
    const expected = binding();
    expect(parseTaskBinding(JSON.stringify(expected))).toEqual(expected);
  });

  it.each([
    ["unknown key", { ...binding(), mystery: true }],
    ["missing key", (() => {
      const malformed: Record<string, unknown> = { ...binding() };
      delete malformed.taskTruncated;
      return malformed;
    })()],
    ["extra key", { ...binding(), extra: "no" }],
    ["wrong type", { ...binding(), prHeadSha: 7 }],
    ["version 3 question binding", {
      version: 3,
      prHeadSha: HEAD_SHA,
      prBaseSha: BASE_SHA,
      titleSha256: "a".repeat(64),
      bodySha256: "b".repeat(64),
      commandPayloadSha256: sha256(PAYLOAD),
      questionTruncated: false,
      diffTruncated: false,
    }],
    ["non-hex head", { ...binding(), prHeadSha: "g".repeat(40) }],
    ["non-hex base", { ...binding(), prBaseSha: "z".repeat(40) }],
    ["non-hex digest", { ...binding(), commandPayloadSha256: "x".repeat(64) }],
    ["non-boolean", { ...binding(), taskTruncated: "false" }],
    ["wrong kind", { ...binding(), kind: "owner-question" }],
    ["non-object", []],
  ])("N17/N18: rejects %s", (_name, malformed) => {
    expect(() => parseTaskBinding(JSON.stringify(malformed))).toThrow(
      TypeError,
    );
  });

  it("N17: malformed JSON throws loudly", () => {
    expect(() => parseTaskBinding("{")).toThrow(SyntaxError);
  });
});

describe("task markers and replay helpers", () => {
  it("builds the distinct marker and exact commit trailer", () => {
    expect(buildTaskApplyMarker(73)).toBe("<!-- owner-task-apply: 73 -->");
    expect(buildTaskTrailer(73)).toBe("Owner-Task-Comment: 73");
    expect(() => buildTaskApplyMarker(0)).toThrow(RangeError);
  });

  it("N22: a 9e owner-command-response marker does not satisfy task replay", () => {
    expect(hasExistingTaskApply([{
      user: { login: BOT_LOGIN },
      body: "<!-- owner-command-response: 73 -->",
    }], 73, BOT_LOGIN)).toBe(false);
  });

  it("N22: requires bot identity and a terminal standalone final line", () => {
    const marker = buildTaskApplyMarker(73);
    expect(hasExistingTaskApply([
      { user: { login: BOT_LOGIN }, body: `done\n${marker}\n \t` },
    ], 73, BOT_LOGIN)).toBe(true);
    expect(hasExistingTaskApply([
      { user: { login: "attacker" }, body: marker },
      { user: { login: BOT_LOGIN }, body: `prefix${marker}` },
      { user: { login: BOT_LOGIN }, body: `${marker}\ntrailing` },
      null,
    ], 73, BOT_LOGIN)).toBe(false);
  });

  it("N22: fails loudly on malformed replay state", () => {
    expect(() => hasExistingTaskApply(null, 73, BOT_LOGIN)).toThrow(TypeError);
    expect(() => hasExistingTaskApply([], 73, "")).toThrow(TypeError);
    expect(() => hasExistingTaskApply([
      { user: { login: BOT_LOGIN }, body: 7 },
    ], 73, BOT_LOGIN)).toThrow(TypeError);
  });

  it("detects an exact trailer across a bounded commit window", () => {
    expect(findTaskTrailerCommit([
      { commit: { message: "first" } },
      { commit: { message: "subject\r\n\r\nOwner-Task-Comment: 73\r\n" } },
    ], 73)).toBe(true);
    expect(findTaskTrailerCommit([
      { commit: { message: "Owner-Task-Comment: 730" } },
    ], 73)).toBe(false);
  });

  it("fails closed when the commit window is malformed or exceeds 100", () => {
    expect(() => findTaskTrailerCommit(null, 73)).toThrow(TypeError);
    expect(() => findTaskTrailerCommit(
      Array.from({ length: 101 }, () => ({ commit: { message: "x" } })),
      73,
    )).toThrow(RangeError);
    expect(() => findTaskTrailerCommit([{}], 73)).toThrow(TypeError);
  });

  it("N21: neutralises both marker grammars in rendered untrusted text", () => {
    const rendered =
      "x <!-- owner-command-response: 8 --> y\n<!-- owner-task-apply: 9 -->";
    const neutralized = neutralizeTaskMarkers(rendered);
    expect(neutralized).not.toContain("owner-command-response");
    expect(neutralized).not.toContain("owner-task-apply");
    expect(neutralized.match(/\[owner-task marker removed\]/g)).toHaveLength(2);
  });
});

describe("ordered owner-task patch decision", () => {
  it.each([
    ["N12 non-PR", { issue: {} }],
    ["N13 fork", {
      pullRequest: pullRequest({ repository: "fork/repository" }),
    }],
    ["N14 closed", {
      pullRequest: pullRequest({ state: "closed" }),
    }],
    ["N15 merged", {
      pullRequest: pullRequest({ merged: true }),
    }],
    ["N16 ineligible author", { author: { login: "not-an-owner" } }],
    ["N16 wrong verb", { commentBody: `@claude question${PAYLOAD}` }],
  ] satisfies readonly (readonly [string, Partial<OwnerTaskPatchDecisionInput>])[])(
    "Fold 8: re-derives eligibility from raw fetched records for %s",
    (_name, ineligibleRecords) => {
      expect(decideOwnerTaskPatch(decisionInput({
        ...ineligibleRecords,
        markerPresent: true,
      }))).toEqual({ kind: "ignore" });
    },
  );

  it("Fold 8: exposes no pre-judged authorization field and ignores an untyped forged judgment", () => {
    const hasAuthorizationField: "authorization" extends
      keyof OwnerTaskPatchDecisionInput ? true : false = false;
    expect(hasAuthorizationField).toBe(false);

    const forgedInput = {
      ...decisionInput({ author: { login: "not-an-owner" } }),
      authorization: {
        proceed: true as const,
        command: { verb: "task" as const, payload: PAYLOAD, truncated: false },
      },
    };
    expect(decideOwnerTaskPatch(forgedInput)).toEqual({ kind: "ignore" });
  });

  it.each([
    ["T4 marker replay", { markerPresent: true }],
    ["T4 trailer replay", { trailerCommitPresent: true }],
  ])("row 2: %s is no-op success before binding validation", (_name, replay) => {
    expect(decideOwnerTaskPatch(decisionInput({
      ...replay,
      bindingArtifact: null,
    }))).toEqual({ kind: "no-op-success" });
  });

  it("row 2 fails closed for malformed replay evidence", () => {
    expect(() => decideOwnerTaskPatch(decisionInput({
      markerPresent: "yes" as unknown as boolean,
    }))).toThrow(TypeError);
  });

  it.each([
    ["missing", null, Error, /binding artifact is missing/],
    ["oversized", "x".repeat(256 * 1024 + 1), Error, /binding artifact is oversized/],
    ["malformed", "{}", TypeError, /binding artifact is malformed/],
  ])(
    "row 3: %s binding aborts loudly with the specific error",
    (_name, bindingArtifact, errorType, messagePattern) => {
      const decide = () => decideOwnerTaskPatch(decisionInput({ bindingArtifact }));
      expect(decide).toThrow(errorType);
      expect(decide).toThrow(messagePattern);
    },
  );

  it.each([
    ["payload hash", JSON.stringify(binding({ commandPayloadSha256: "a".repeat(64) }))],
    ["truncation", JSON.stringify(binding({ taskTruncated: true }))],
  ])("row 3: %s drift aborts loudly", (_name, bindingArtifact) => {
    expect(() => decideOwnerTaskPatch(decisionInput({ bindingArtifact })))
      .toThrow(/does not match/);
  });

  it("Fold 10: rejects a truncated owner task before artifact analysis", () => {
    const fullPayload = ` ${"x".repeat(4001)}`;
    const retainedPayload = [...fullPayload].slice(0, 4000).join("");
    const truncatedInput = {
      commentBody: `@claude task${fullPayload}`,
      bindingArtifact: JSON.stringify(binding({
        commandPayloadSha256: sha256(retainedPayload),
        taskTruncated: true,
      })),
    };
    const outcome = decideOwnerTaskPatch(decisionInput(truncatedInput));

    expect(outcome).toEqual({
      kind: "reject-notice",
      stage: "patch-artifact",
      reasons: ["owner task was truncated; reissue a shorter command"],
    });
    expect(outcome.kind).not.toBe("apply");
    expect(decideOwnerTaskPatch(decisionInput({
      ...truncatedInput,
      patchArtifactBytes: 0,
    }))).toEqual(outcome);
  });

  it.each([
    ["invalid size", -1, { status: "failed" as const, reasons: ["x"] }],
    ["oversized artifact", MAX_PATCH_BYTES + 1, { status: "failed" as const, reasons: ["x"] }],
  ])("row 4: rejects %s before freshness", (_name, bytes, patchAnalysis) => {
    const outcome = decideOwnerTaskPatch(decisionInput({
      patchArtifactBytes: bytes,
      patchAnalysis,
      pullRequest: pullRequest({ headSha: ADVANCED_HEAD_SHA }),
    }));
    expect(outcome).toMatchObject({
      kind: "reject-notice",
      stage: "patch-artifact",
    });
  });

  it("N10 row 4: zero-byte artifact rejects before an otherwise-valid analysis can apply", () => {
    const outcome = decideOwnerTaskPatch(decisionInput({
      patchArtifactBytes: 0,
    }));

    expect(outcome).toEqual({
      kind: "reject-notice",
      stage: "patch-artifact",
      reasons: ["patch artifact is empty or has an invalid size"],
    });
    expect(outcome.kind).not.toBe("apply");
  });

  it("Fold 2: accepts a patch artifact exactly at MAX_PATCH_BYTES", () => {
    expect(decideOwnerTaskPatch(decisionInput({
      patchArtifactBytes: MAX_PATCH_BYTES,
    }))).toMatchObject({ kind: "apply" });
  });

  it("N1/N2 row 5: an advanced head produces stale notice before apply failure", () => {
    expect(decideOwnerTaskPatch(decisionInput({
      pullRequest: pullRequest({ headSha: ADVANCED_HEAD_SHA }),
      patchAnalysis: { status: "failed", reasons: ["apply failed"] },
    }))).toEqual({
      kind: "stale-notice",
      expectedHeadSha: HEAD_SHA,
      currentHeadSha: ADVANCED_HEAD_SHA,
      expectedBaseSha: BASE_SHA,
      currentBaseSha: BASE_SHA,
    });
    expect(() => decideOwnerTaskPatch(decisionInput({
      pullRequest: pullRequest({ headSha: "bad" }),
    })))
      .toThrow(TypeError);
  });

  it("Fold 9: base drift is stale even when the authorised head and command are unchanged", () => {
    const driftedPullRequest = pullRequest({ baseSha: ADVANCED_BASE_SHA });
    const outcome = decideOwnerTaskPatch(decisionInput({
      pullRequest: driftedPullRequest,
    }));

    const expected = {
      kind: "stale-notice" as const,
      expectedHeadSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
      currentBaseSha: ADVANCED_BASE_SHA,
    };
    expect(outcome).toEqual(expected);
    expect(outcome.kind).not.toBe("apply");
    expect(decideOwnerTaskPatch(decisionInput({
      pullRequest: driftedPullRequest,
      patchAnalysis: { status: "failed", reasons: ["apply failed"] },
    }))).toEqual(expected);
  });

  it.each([
    ["malformed head SHA", pullRequest({ headSha: "bad" })],
    ["non-string head SHA", pullRequest({ headSha: 7 })],
    ["malformed base SHA", pullRequest({ baseSha: "bad" })],
    ["non-string base SHA", pullRequest({ baseSha: 7 })],
    ["missing base record", {
      head: {
        sha: HEAD_SHA,
        repo: { full_name: REPOSITORY },
      },
      state: "open",
      merged: false,
    }],
  ])("fails closed for %s from the fetched PR record", (_name, fetchedPr) => {
    expect(() => decideOwnerTaskPatch(decisionInput({ pullRequest: fetchedPr })))
      .toThrow(TypeError);
  });

  it("Fold 5 row 6: failed binary/encoding/apply analysis rejects after freshness", () => {
    expect(decideOwnerTaskPatch(decisionInput({
      patchAnalysis: {
        status: "failed",
        reasons: ["binary/encoding analysis failed"],
      },
    }))).toEqual({
      kind: "reject-notice",
      stage: "patch-analysis",
      reasons: ["binary/encoding analysis failed"],
    });
  });

  it.each([
    ".github/workflows/x.yml",
    "scripts/factory/x.mts",
    ".claude/settings.json",
    ".codex/config.toml",
    "tests/factory/x.test.ts",
    "CODEOWNERS",
    "docs/CODEOWNERS",
    "AGENTS.md",
    "docs/state/registry.md",
    "some/dir/CLAUDE.md",
    "some/dir/.claude",
    "../outside.ts",
  ])("N4 row 7: rejects protected path %s", (path) => {
    const outcome = decideOwnerTaskPatch(decisionInput({
      patchAnalysis: {
        status: "ok",
        analysis: {
          baseSha: HEAD_SHA,
          treeOid: TREE_OID,
          changedPaths: [path],
          diffText: "",
          lineStats: [lineStat(path)],
        },
      },
    }));
    expect(outcome).toMatchObject({
      kind: "reject-notice",
      stage: "protected-path",
    });
  });

  it("N5 row 7: rejects a rename whose source side is protected", () => {
    const outcome = decideOwnerTaskPatch(decisionInput({
      patchAnalysis: {
        status: "ok",
        analysis: {
          baseSha: HEAD_SHA,
          treeOid: TREE_OID,
          changedPaths: ["scripts/factory/old.mts", "lib/new.mts"],
          diffText: "",
          lineStats: [lineStat("lib/new.mts", {
            sourcePath: "scripts/factory/old.mts",
          })],
        },
      },
    }));
    expect(outcome).toMatchObject({ kind: "reject-notice", stage: "protected-path" });
  });

  it.each([
    ["N6 binary", [lineStat("lib/blob.bin", { additions: null, deletions: null })]],
    ["N7 over 400 text lines", [lineStat("lib/large.ts", { additions: 401 })]],
    ["N8 inert/logic mix", [lineStat("generated/schema.json"), lineStat("lib/x.ts")]],
  ])("row 8: rejects %s envelope", (_name, lineStats) => {
    const changedPaths = lineStats.flatMap((stat) =>
      stat.sourcePath === undefined ? [stat.path] : [stat.sourcePath, stat.path]);
    expect(decideOwnerTaskPatch(decisionInput({
      patchAnalysis: {
        status: "ok",
        analysis: {
          baseSha: HEAD_SHA,
          treeOid: TREE_OID,
          changedPaths,
          diffText: "",
          lineStats,
        },
      },
    }))).toMatchObject({ kind: "reject-notice", stage: "envelope" });
  });

  it("Fold 1: rejects analysis based on a commit other than the authorised head", () => {
    const outcome = decideOwnerTaskPatch(decisionInput({
      patchAnalysis: {
        status: "ok",
        analysis: {
          baseSha: ADVANCED_HEAD_SHA,
          treeOid: TREE_OID,
          changedPaths: ["lib/change.ts"],
          diffText: "",
          lineStats: [lineStat()],
        },
      },
    }));

    expect(outcome).toEqual({
      kind: "reject-notice",
      stage: "patch-analysis",
      reasons: ["patch analysis base does not match the authorised head"],
    });
    expect(outcome.kind).not.toBe("apply");
  });

  it("fails closed for unknown, malformed, or empty analysis state", () => {
    expect(decideOwnerTaskPatch(decisionInput({
      patchAnalysis: { status: "mystery" } as never,
    }))).toMatchObject({ kind: "reject-notice", stage: "patch-analysis" });
    for (const analysis of [
      { baseSha: "bad", treeOid: TREE_OID, changedPaths: ["lib/x.ts"], diffText: "", lineStats: [lineStat()] },
      { baseSha: HEAD_SHA, treeOid: "bad", changedPaths: ["lib/x.ts"], diffText: "", lineStats: [lineStat()] },
      { baseSha: HEAD_SHA, treeOid: TREE_OID, changedPaths: [], diffText: "", lineStats: [] },
      { baseSha: HEAD_SHA, treeOid: TREE_OID, changedPaths: [7], diffText: "", lineStats: [lineStat()] },
      { baseSha: HEAD_SHA, treeOid: TREE_OID, changedPaths: ["lib/x.ts"], diffText: 7, lineStats: [lineStat()] },
      { baseSha: HEAD_SHA, treeOid: TREE_OID, changedPaths: ["lib/x.ts"], diffText: "", lineStats: [{}] },
    ]) {
      expect(decideOwnerTaskPatch(decisionInput({
        patchAnalysis: { status: "ok", analysis } as never,
      }))).toMatchObject({ kind: "reject-notice", stage: "patch-analysis" });
    }
  });

  it("T7 rows 9/10: gaming evidence annotates but still applies the exact tree", () => {
    const diffText = `diff --git a/tests/example.test.ts b/tests/example.test.ts
--- /dev/null
+++ b/tests/example.test.ts
@@ -0,0 +1,1 @@
+/* v8 ignore next */ export const tested = true;
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,0 +2,1 @@
+"test": "echo bypass"
diff --git a/pyproject.toml b/pyproject.toml
--- /dev/null
+++ b/pyproject.toml
@@ -0,0 +1,1 @@
+[tool.pytest.ini_options]
`;
    const gamingPayload = " add tests [skip ci] @codex review";
    const outcome = decideOwnerTaskPatch(decisionInput({
      commentBody: `@claude task${gamingPayload}`,
      bindingArtifact: JSON.stringify(binding({
        commandPayloadSha256: sha256(gamingPayload),
      })),
      patchAnalysis: {
        status: "ok",
        analysis: {
          baseSha: HEAD_SHA,
          treeOid: TREE_OID,
          changedPaths: [
            "tests/example.test.ts",
            "package.json",
            "pyproject.toml",
          ],
          diffText,
          lineStats: [
            lineStat("tests/example.test.ts"),
            lineStat("package.json"),
            lineStat("pyproject.toml"),
          ],
        },
      },
    }));
    expect(outcome).toMatchObject({
      kind: "apply",
      treeOid: TREE_OID,
      parent: HEAD_SHA,
      trailer: "Owner-Task-Comment: 73",
      forceWithLeaseExpectedSha: HEAD_SHA,
      annotations: {
        testFileEdits: ["tests/example.test.ts"],
        coverageSuppressions: [{
          path: "tests/example.test.ts",
          line: "/* v8 ignore next */ export const tested = true;",
        }],
        packageJsonTestScriptEdits: ["\"test\": \"echo bypass\""],
        rootPytestConfigSections: ["[tool.pytest.ini_options]"],
      },
    });
    if (outcome.kind !== "apply") throw new Error("expected apply outcome");
    expect(outcome.commitSubject).not.toMatch(/\[skip ci\]|@codex/iu);
  });

  it("row 10: a clean patch applies with empty annotations", () => {
    expect(decideOwnerTaskPatch(decisionInput())).toMatchObject({
      kind: "apply",
      annotations: {
        testFileEdits: [],
        coverageSuppressions: [],
        packageJsonTestScriptEdits: [],
        rootPytestConfigSections: [],
      },
    });
  });
});
