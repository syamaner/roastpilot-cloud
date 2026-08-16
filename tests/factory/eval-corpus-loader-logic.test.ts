import { describe, expect, it } from "vitest";
import {
  MAX_DECISION_CONTEXT_BYTES,
  assembleCorpus,
} from "../../scripts/factory/eval/corpus-loader-logic.mts";
import { MAX_MANIFEST_BYTES } from "../../scripts/factory/eval/corpus-manifest-schema.mts";
import { MAX_PAYLOAD_BYTES } from "../../scripts/factory/triage-verdict-schema.mts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

interface FixtureOptions {
  readonly caseId?: string;
  readonly implement?: boolean;
  readonly decision?: boolean;
  readonly readiness?: string;
}

function fixture(options: FixtureOptions = {}): {
  manifest: Record<string, unknown>;
  files: Map<string, string>;
} {
  const caseId = options.caseId ?? "issue-009-example";
  const issueNumber = Number(/^issue-(\d+)-/.exec(caseId)?.[1] ?? "9");
  const implement = options.implement ?? false;
  const decision = options.decision ?? false;
  const readiness = options.readiness ?? "needs-info";
  const corpusCase = {
    caseId, issueNumber, prNumber: implement ? 10 : null,
    stage: implement ? "triage-and-implement" : "triage-only",
    baseSha: SHA, capturedAt: "2026-08-16T08:57:42Z",
    pin: { actionRef: "v1", actionCommit: SHA, resolvedModel: null, triageSkillVersion: null, implementPromptVersion: null },
    issueSnapshotPath: `inputs/${caseId}/issue-snapshot.json`,
    decisionContextPath: decision ? `inputs/${caseId}/decision-context.md` : null,
    recorded: {
      triageVerdictPath: `inputs/${caseId}/recorded/triage-verdict.json`,
      implementPatchPath: implement ? `inputs/${caseId}/recorded/implement.patch` : null,
    },
    notes: "A faithful historical case.",
  };
  const expected = {
    schemaVersion: 1, caseId, issueType: "feature", triageOutcomeClass: "ready",
    execution: "factory", sizeClass: implement ? "small" : null,
    outcomeClass: implement ? "clean-pass" : null,
    provenance: "historical-artifact", triage: { expectedReadiness: readiness },
    implement: implement ? {
      compile: "pass", tests: "pass", implementLogicLines: 0,
      diffBound: { expectedWithinEnvelope: true }, mutation: null,
      prOutcome: { merged: true, firstPassCiGreen: true, postOpenReviewRounds: 0 },
    } : null,
  };
  const files = new Map<string, string>([
    [`inputs/${caseId}/issue-snapshot.json`, JSON.stringify({
      issueNumber, title: "A bounded issue", body: "Neutral acceptance criteria.",
      labels: ["needs-triage"], state: "OPEN", snapshotAt: "2026-08-16T08:57:42Z",
      sourceUrl: `https://github.com/syamaner/roastpilot-cloud/issues/${String(issueNumber)}`,
    })],
    [`inputs/${caseId}/recorded/triage-verdict.json`, "recorded opaque verdict"],
    [`expectations/${caseId}/expected.json`, JSON.stringify(expected)],
    ["README.md", "Documentation only."],
  ]);
  if (decision) files.set(`inputs/${caseId}/decision-context.md`, "Neutral decision context.");
  if (implement) files.set(`inputs/${caseId}/recorded/implement.patch`, "Neutral recorded patch.");
  return { manifest: { schemaVersion: 1, description: "A neutral corpus.", cases: [corpusCase] }, files };
}

function load(value: ReturnType<typeof fixture>) {
  return assembleCorpus(JSON.stringify(value.manifest), value.files);
}

function firstCase(value: ReturnType<typeof fixture>): Record<string, unknown> {
  return (value.manifest.cases as Record<string, unknown>[])[0];
}

describe("assembleCorpus", () => {
  it("T39 loads a minimal corpus and constructs its partition", () => {
    const result = load(fixture());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.producerVisiblePaths]).toEqual([
        "manifest.json", "inputs/issue-009-example/issue-snapshot.json",
        "inputs/issue-009-example/recorded/triage-verdict.json",
      ]);
      expect([...result.value.scorerVisiblePaths]).toEqual(["expectations/issue-009-example/expected.json"]);
    }
  });

  it("T40 returns failure without throwing for non-JSON manifest text", () => {
    expect(() => assembleCorpus("{", new Map())).not.toThrow();
    expect(assembleCorpus("{", new Map()).ok).toBe(false);
  });

  it.each([
    ["T41 missing snapshot", "inputs/issue-009-example/issue-snapshot.json"],
    ["T42 missing expected", "expectations/issue-009-example/expected.json"],
  ])("%s fails closed", (_name, path) => {
    const value = fixture(); value.files.delete(path); expect(load(value).ok).toBe(false);
  });

  it("T43 rejects an orphan inputs directory", () => {
    const value = fixture(); value.files.set("inputs/issue-010-orphan/issue-snapshot.json", "{}");
    expect(load(value).ok).toBe(false);
  });

  it("T44 rejects an orphan expectations directory", () => {
    const value = fixture(); value.files.set("expectations/issue-010-orphan/expected.json", "{}");
    expect(load(value).ok).toBe(false);
  });

  it("T45 rejects a non-canonical extra file", () => {
    const value = fixture(); value.files.set("inputs/issue-009-example/extra.txt", "x");
    expect(load(value).ok).toBe(false);
  });

  it("rejects a disallowed root-level entry", () => {
    const value = fixture(); value.files.set("answers.txt", "not allowed");
    expect(load(value).ok).toBe(false);
  });

  it("T46 rejects an expected caseId that differs from its directory and manifest", () => {
    const value = fixture();
    const path = "expectations/issue-009-example/expected.json";
    const raw = JSON.parse(value.files.get(path) as string) as Record<string, unknown>;
    raw.caseId = "issue-010-other"; value.files.set(path, JSON.stringify(raw));
    expect(load(value).ok).toBe(false);
  });

  it("T47 rejects snapshot issueNumber disagreement", () => {
    const value = fixture(); const path = "inputs/issue-009-example/issue-snapshot.json";
    const raw = JSON.parse(value.files.get(path) as string) as Record<string, unknown>;
    raw.issueNumber = 10; raw.sourceUrl = "https://github.com/syamaner/roastpilot-cloud/issues/10";
    value.files.set(path, JSON.stringify(raw)); expect(load(value).ok).toBe(false);
  });

  it("rejects a snapshot captured after the manifest capture boundary", () => {
    const value = fixture();
    mutateSnapshot(value, (raw) => { raw.snapshotAt = "2026-08-16T08:57:43Z"; });
    const result = load(value); expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        "issue-009-example snapshotAt is later than capturedAt",
      );
    }
  });

  it("propagates parsed snapshot and expectation validation failures", () => {
    const invalidSnapshot = fixture();
    const snapshotPath = "inputs/issue-009-example/issue-snapshot.json";
    const snapshot = JSON.parse(invalidSnapshot.files.get(snapshotPath) as string) as Record<string, unknown>;
    snapshot.state = "open";
    invalidSnapshot.files.set(snapshotPath, JSON.stringify(snapshot));
    const snapshotResult = load(invalidSnapshot);
    expect(snapshotResult.ok).toBe(false);
    if (!snapshotResult.ok) expect(snapshotResult.errors.join(" ")).toContain("snapshot.state");

    const invalidExpected = fixture();
    const expectedPath = "expectations/issue-009-example/expected.json";
    const expected = JSON.parse(invalidExpected.files.get(expectedPath) as string) as Record<string, unknown>;
    expected.execution = "Factory";
    invalidExpected.files.set(expectedPath, JSON.stringify(expected));
    const expectedResult = load(invalidExpected);
    expect(expectedResult.ok).toBe(false);
    if (!expectedResult.ok) expect(expectedResult.errors.join(" ")).toContain("expected.execution");
  });

  it("rejects invalid JSON in a snapshot and expectation without throwing", () => {
    for (const path of [
      "inputs/issue-009-example/issue-snapshot.json",
      "expectations/issue-009-example/expected.json",
    ]) {
      const value = fixture(); value.files.set(path, "{");
      const result = load(value); expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain(`${path} is not valid JSON`);
    }
  });

  it("T48 enforces decision-context presence in both directions", () => {
    const absentReference = fixture({ decision: true });
    absentReference.files.delete("inputs/issue-009-example/decision-context.md");
    expect(load(absentReference).ok).toBe(false);
    const unexpectedFile = fixture();
    unexpectedFile.files.set("inputs/issue-009-example/decision-context.md", "unexpected");
    expect(load(unexpectedFile).ok).toBe(false);
  });

  it("rejects an implement patch when implementPatchPath is null", () => {
    const value = fixture();
    value.files.set("inputs/issue-009-example/recorded/implement.patch", "unexpected");
    const result = load(value); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("implementPatchPath is null");
  });

  it("rejects every present-but-empty required artifact", () => {
    const paths = [
      "inputs/issue-009-example/issue-snapshot.json",
      "inputs/issue-009-example/recorded/triage-verdict.json",
      "expectations/issue-009-example/expected.json",
    ];
    for (const path of paths) {
      const value = fixture(); value.files.set(path, "");
      const result = load(value); expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain(`${path} is empty`);
    }
    for (const [options, path] of [
      [{ decision: true }, "inputs/issue-009-example/decision-context.md"],
      [{ implement: true }, "inputs/issue-009-example/recorded/implement.patch"],
    ] as const) {
      const value = fixture(options); value.files.set(path, "");
      const result = load(value); expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain(`${path} is empty`);
    }
  });

  it("rejects oversized parsed JSON and opaque required evidence", () => {
    const manifestValue = fixture();
    manifestValue.manifest.description = "x".repeat(MAX_MANIFEST_BYTES);
    const manifestResult = load(manifestValue); expect(manifestResult.ok).toBe(false);
    if (!manifestResult.ok) expect(manifestResult.errors.join(" ")).toContain(String(MAX_MANIFEST_BYTES));

    const verdictValue = fixture();
    const verdictPath = "inputs/issue-009-example/recorded/triage-verdict.json";
    verdictValue.files.set(verdictPath, "x".repeat(MAX_PAYLOAD_BYTES + 1));
    const verdictResult = load(verdictValue); expect(verdictResult.ok).toBe(false);
    if (!verdictResult.ok) expect(verdictResult.errors.join(" ")).toContain(String(MAX_PAYLOAD_BYTES));

    const decisionValue = fixture({ decision: true });
    const decisionPath = "inputs/issue-009-example/decision-context.md";
    decisionValue.files.set(decisionPath, "x".repeat(MAX_DECISION_CONTEXT_BYTES + 1));
    expect(load(decisionValue).ok).toBe(false);
  });

  it("T49 enforces stage iff implement-null in both directions", () => {
    const triage = fixture();
    const triagePath = "expectations/issue-009-example/expected.json";
    const implementExpected = JSON.parse(fixture({ implement: true }).files.get(triagePath) as string);
    triage.files.set(triagePath, JSON.stringify(implementExpected));
    expect(load(triage).ok).toBe(false);
    const implementation = fixture({ implement: true });
    const expected = JSON.parse(implementation.files.get(triagePath) as string) as Record<string, unknown>;
    expected.implement = null; expected.sizeClass = null; expected.outcomeClass = null;
    implementation.files.set(triagePath, JSON.stringify(expected));
    expect(load(implementation).ok).toBe(false);
  });

  it("T50 refuses a partial load when one of two cases is invalid", () => {
    const first = fixture(); const second = fixture({ caseId: "issue-010-second" });
    const combined = { ...first, manifest: { ...first.manifest, cases: [...first.manifest.cases as unknown[], ...second.manifest.cases as unknown[]] } };
    second.files.forEach((text, path) => { if (path !== "README.md") combined.files.set(path, text); });
    combined.files.delete("inputs/issue-010-second/issue-snapshot.json");
    expect(load(combined).ok).toBe(false);
  });

  it("T51 excludes recorded and expectations from triage producer inputs", () => {
    const result = load(fixture({ implement: true, decision: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = [...result.value.cases[0].triageProducerInputs];
      expect(paths.some((path) => path.includes("/recorded/"))).toBe(false);
      expect(paths.some((path) => path.startsWith("expectations/"))).toBe(false);
    }
  });

  it("T62 rejects own-label leaks on every specified producer-visible surface", () => {
    const mutations: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
      ["snapshot.title", (value) => mutateSnapshot(value, (raw) => { raw.title = "NEEDS-INFO"; })],
      ["snapshot.body", (value) => mutateSnapshot(value, (raw) => { raw.body = "Needs-Info"; })],
      ["snapshot.labels", (value) => mutateSnapshot(value, (raw) => { raw.labels = ["needs-info"]; })],
      ["decision-context", (value) => { value.files.set("inputs/issue-009-example/decision-context.md", "needs-info"); }],
      ["implement.patch", (value) => { value.files.set("inputs/issue-009-example/recorded/implement.patch", "needs-info"); }],
      ["manifest notes", (value) => { firstCase(value).notes = "needs-info"; }],
      ["manifest description", (value) => { value.manifest.description = "needs-info"; }],
      ["manifest pin.actionRef", (value) => {
        (firstCase(value).pin as Record<string, unknown>).actionRef = "release needs-info candidate";
      }],
      ["manifest pin.resolvedModel", (value) => {
        (firstCase(value).pin as Record<string, unknown>).resolvedModel = "model-needs-info-preview";
      }],
    ];
    for (const [surface, mutate] of mutations) {
      const value = fixture({ implement: true, decision: true }); mutate(value);
      const result = load(value); expect(result.ok, surface).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/needs-info|answer-verdict/);
      if (!result.ok && surface.startsWith("manifest pin.")) {
        expect(result.errors.join(" ")).toContain(
          `issue-009-example manifest.case.${surface.slice("manifest ".length)} leaks answer-verdict token needs-info`,
        );
      }
    }
    expect(load(fixture({ caseId: "issue-009-needs-info" })).ok).toBe(false);
  });

  it("rejects a cross-case readiness-label leak in the shared manifest", () => {
    const first = fixture({ readiness: "needs-info" });
    const second = fixture({ caseId: "issue-023-other", readiness: "wontfix" });
    const combined = {
      ...first,
      manifest: {
        ...first.manifest,
        cases: [...first.manifest.cases as unknown[], ...second.manifest.cases as unknown[]],
      },
    };
    second.files.forEach((text, path) => { if (path !== "README.md") combined.files.set(path, text); });
    (firstCase(combined).pin as Record<string, unknown>).actionRef = "wontfix";

    const result = load(combined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain(
        "issue-009-example manifest.case.pin.actionRef leaks answer-verdict token wontfix",
      );
    }
  });

  it.each(["non-pass", "clean-pass", "bounced", "merged"])(
    "rejects outcome token %s in a producer-readable manifest pin",
    (token) => {
      const value = fixture({ implement: true });
      (firstCase(value).pin as Record<string, unknown>).actionRef = token;

      const result = load(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toContain(
          `issue-009-example manifest.case.pin.actionRef leaks answer-verdict token ${token}`,
        );
      }
    },
  );

  it("allows another case's readiness label in case-relative input files", () => {
    const first = fixture({ readiness: "needs-info" });
    const second = fixture({ caseId: "issue-023-other", readiness: "wontfix" });
    const combined = {
      ...first,
      manifest: {
        ...first.manifest,
        cases: [...first.manifest.cases as unknown[], ...second.manifest.cases as unknown[]],
      },
    };
    second.files.forEach((text, path) => { if (path !== "README.md") combined.files.set(path, text); });
    mutateSnapshot(combined, (raw) => {
      raw.body = "Historical disposition was wontfix.";
      raw.labels = ["wontfix"];
    });

    expect(load(combined).ok).toBe(true);
  });

  it("T63 allows a different readiness label in body and labels", () => {
    const value = fixture({ readiness: "needs-info" });
    mutateSnapshot(value, (raw) => { raw.body = "History says ready-to-spec."; raw.labels = ["ready-to-spec"]; });
    expect(load(value).ok).toBe(true);
  });

  it("T64 excludes the recorded triage verdict from N9", () => {
    const value = fixture();
    value.files.set("inputs/issue-009-example/recorded/triage-verdict.json", '{"readiness":"needs-info"}');
    expect(load(value).ok).toBe(true);
  });

  it.each([
    ["NEEDS-INFO", false], ["Needs-Info", false],
    ["needs-information", true], ["not-needs-info-yet", false],
  ])("T65 applies delimiter-bounded matching to %s", (body, clean) => {
    const value = fixture(); mutateSnapshot(value, (raw) => { raw.body = body; });
    expect(load(value).ok).toBe(clean);
  });

  it("T76 carries the recorded triage verdict text verbatim without parsing", () => {
    const result = load(fixture());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cases[0].recordedTriageVerdictText).toBe("recorded opaque verdict");
    }
  });

  it("T77 carries recorded implement patch text verbatim or null", () => {
    const implementation = load(fixture({ implement: true }));
    expect(implementation.ok).toBe(true);
    if (implementation.ok) {
      expect(implementation.value.cases[0].recordedImplementPatchText).toBe("Neutral recorded patch.");
    }

    const triageOnly = load(fixture());
    expect(triageOnly.ok).toBe(true);
    if (triageOnly.ok) {
      expect(triageOnly.value.cases[0].recordedImplementPatchText).toBeNull();
    }
  });
});

function mutateSnapshot(
  value: ReturnType<typeof fixture>,
  mutate: (raw: Record<string, unknown>) => void,
): void {
  const path = [...value.files.keys()].find((candidate) => candidate.endsWith("/issue-snapshot.json")) as string;
  const raw = JSON.parse(value.files.get(path) as string) as Record<string, unknown>;
  mutate(raw); value.files.set(path, JSON.stringify(raw));
}
