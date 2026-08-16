import {
  MAX_MANIFEST_BYTES,
  validateCorpusManifest,
  type CorpusCase,
  type CorpusManifest,
} from "./corpus-manifest-schema.mts";
import {
  MAX_EXPECTED_BYTES,
  validateExpectedResult,
  type ExpectedResult,
} from "./expected-result-schema.mts";
import {
  MAX_SNAPSHOT_BYTES,
  validateIssueSnapshot,
  type IssueSnapshot,
} from "./issue-snapshot-schema.mts";
import { MAX_PAYLOAD_BYTES } from "../triage-verdict-schema.mts";
import {
  containsDelimiterBoundedToken,
  isUtf8PayloadWithinLimit,
  type ValidationResult,
} from "./validation-common.mts";

export const MAX_DECISION_CONTEXT_BYTES = 262_144;
export const MAX_RECORDED_PATCH_BYTES = 2_097_152;

export interface LoadedCase {
  readonly case: CorpusCase;
  readonly snapshot: IssueSnapshot;
  readonly expected: ExpectedResult;
  readonly decisionContextText: string | null;
  readonly triageProducerInputs: ReadonlySet<string>;
  readonly replayArtifacts: ReadonlySet<string>;
  readonly scorerOnly: ReadonlySet<string>;
}

export interface LoadedCorpus {
  readonly manifest: CorpusManifest;
  readonly cases: readonly LoadedCase[];
  readonly producerVisiblePaths: ReadonlySet<string>;
  readonly scorerVisiblePaths: ReadonlySet<string>;
}

export type LoadResult = ValidationResult<LoadedCorpus>;

function parseBoundedJson(
  text: string,
  maximumBytes: number,
  path: string,
  errors: string[],
): unknown | undefined {
  if (!isUtf8PayloadWithinLimit(text, maximumBytes)) {
    errors.push(`${path} exceeds ${String(maximumBytes)} UTF-8 bytes`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    errors.push(`${path} is not valid JSON`);
    return undefined;
  }
}

function requiredText(
  files: ReadonlyMap<string, string>,
  path: string,
  maximumBytes: number,
  errors: string[],
): string | undefined {
  const text = files.get(path);
  if (text === undefined) {
    errors.push(`${path} is missing`);
    return undefined;
  }
  if (!isUtf8PayloadWithinLimit(text, maximumBytes)) {
    errors.push(`${path} exceeds ${String(maximumBytes)} UTF-8 bytes`);
    return undefined;
  }
  return text;
}

function noteLeak(
  caseId: string,
  surface: string,
  text: string,
  label: string,
  errors: string[],
): void {
  if (containsDelimiterBoundedToken(text, label)) {
    errors.push(`${caseId} ${surface} leaks own readiness label ${label}`);
  }
}

function scanAnswerNeutrality(
  corpusCase: CorpusCase,
  manifest: CorpusManifest,
  snapshot: IssueSnapshot,
  expected: ExpectedResult,
  decisionContextText: string | null,
  patchText: string | null,
  errors: string[],
): void {
  const label = expected.triage.expectedReadiness;
  noteLeak(corpusCase.caseId, "snapshot.title", snapshot.title, label, errors);
  noteLeak(corpusCase.caseId, "snapshot.body", snapshot.body, label, errors);
  snapshot.labels.forEach((value, index) =>
    noteLeak(corpusCase.caseId, `snapshot.labels[${String(index)}]`, value, label, errors),
  );
  if (decisionContextText !== null) noteLeak(corpusCase.caseId, "decision-context.md", decisionContextText, label, errors);
  if (patchText !== null) noteLeak(corpusCase.caseId, "recorded/implement.patch", patchText, label, errors);
  noteLeak(corpusCase.caseId, "manifest caseId", corpusCase.caseId, label, errors);
  noteLeak(corpusCase.caseId, "manifest notes", corpusCase.notes, label, errors);
  noteLeak(corpusCase.caseId, "manifest description", manifest.description, label, errors);
}

export function assembleCorpus(
  manifestText: string,
  files: ReadonlyMap<string, string>,
): LoadResult {
  const errors: string[] = [];
  const manifestRaw = parseBoundedJson(manifestText, MAX_MANIFEST_BYTES, "manifest.json", errors);
  if (manifestRaw === undefined) return { ok: false, errors };
  const manifestResult = validateCorpusManifest(manifestRaw);
  let manifest: CorpusManifest;
  if (!manifestResult.ok) {
    errors.push(...manifestResult.errors);
    const onlyExistingLeakErrors = manifestResult.errors.every((error) =>
      error.includes("leaks an answer-verdict token"),
    );
    if (!onlyExistingLeakErrors) return { ok: false, errors };
    // The PR-1 validator accumulated no structural/type error, so the raw
    // value is safe to traverse solely to produce the narrower N9 diagnostic.
    manifest = manifestRaw as CorpusManifest;
  } else {
    manifest = manifestResult.value;
  }

  for (const path of files.keys()) {
    if (path !== "README.md" && !path.startsWith("inputs/") && !path.startsWith("expectations/")) {
      errors.push(`${path} is not an allowed corpus root entry`);
    }
  }

  const canonicalPaths = new Set<string>();
  const loadedCases: LoadedCase[] = [];
  for (const corpusCase of manifest.cases) {
    const caseErrors: string[] = [];
    const snapshotPath = corpusCase.issueSnapshotPath;
    const verdictPath = corpusCase.recorded.triageVerdictPath;
    const expectedPath = `expectations/${corpusCase.caseId}/expected.json`;
    canonicalPaths.add(snapshotPath);
    canonicalPaths.add(verdictPath);
    canonicalPaths.add(expectedPath);

    const snapshotText = files.get(snapshotPath);
    let snapshot: IssueSnapshot | undefined;
    if (snapshotText === undefined) {
      caseErrors.push(`${snapshotPath} is missing for ${corpusCase.caseId}`);
    } else {
      const snapshotRaw = parseBoundedJson(snapshotText, MAX_SNAPSHOT_BYTES, snapshotPath, caseErrors);
      if (snapshotRaw !== undefined) {
        const result = validateIssueSnapshot(snapshotRaw);
        if (!result.ok) caseErrors.push(...result.errors.map((error) => `${snapshotPath}: ${error}`));
        else {
          snapshot = result.value;
          if (snapshot.issueNumber !== corpusCase.issueNumber) caseErrors.push(`${snapshotPath} issueNumber does not match manifest case ${corpusCase.caseId}`);
        }
      }
    }

    let decisionContextText: string | null = null;
    const canonicalDecisionPath = `inputs/${corpusCase.caseId}/decision-context.md`;
    if (corpusCase.decisionContextPath === null) {
      if (files.has(canonicalDecisionPath)) caseErrors.push(`${canonicalDecisionPath} is present while decisionContextPath is null`);
    } else {
      canonicalPaths.add(corpusCase.decisionContextPath);
      decisionContextText = requiredText(files, corpusCase.decisionContextPath, MAX_DECISION_CONTEXT_BYTES, caseErrors) ?? null;
    }

    requiredText(files, verdictPath, MAX_PAYLOAD_BYTES, caseErrors);

    let patchText: string | null = null;
    const canonicalPatchPath = `inputs/${corpusCase.caseId}/recorded/implement.patch`;
    if (corpusCase.recorded.implementPatchPath === null) {
      if (files.has(canonicalPatchPath)) caseErrors.push(`${canonicalPatchPath} is present while implementPatchPath is null`);
    } else {
      canonicalPaths.add(corpusCase.recorded.implementPatchPath);
      patchText = requiredText(files, corpusCase.recorded.implementPatchPath, MAX_RECORDED_PATCH_BYTES, caseErrors) ?? null;
    }

    let expected: ExpectedResult | undefined;
    const expectedText = files.get(expectedPath);
    if (expectedText === undefined) {
      caseErrors.push(`${expectedPath} is missing for ${corpusCase.caseId}`);
    } else {
      const expectedRaw = parseBoundedJson(expectedText, MAX_EXPECTED_BYTES, expectedPath, caseErrors);
      if (expectedRaw !== undefined) {
        const result = validateExpectedResult(expectedRaw);
        if (!result.ok) caseErrors.push(...result.errors.map((error) => `${expectedPath}: ${error}`));
        else {
          expected = result.value;
          const directoryCaseId = expectedPath.split("/")[1];
          if (expected.caseId !== directoryCaseId || expected.caseId !== corpusCase.caseId) {
            caseErrors.push(`${expectedPath} caseId must match directory and manifest case ${corpusCase.caseId}`);
          }
          if ((corpusCase.stage === "triage-only") !== (expected.implement === null)) {
            caseErrors.push(`${corpusCase.caseId} stage and expected.implement nullness must agree`);
          }
        }
      }
    }

    if (snapshot !== undefined && expected !== undefined) {
      scanAnswerNeutrality(corpusCase, manifest, snapshot, expected, decisionContextText, patchText, caseErrors);
    }

    errors.push(...caseErrors);
    if (caseErrors.length === 0 && snapshot !== undefined && expected !== undefined) {
      const triageProducerInputs = new Set<string>([snapshotPath]);
      if (corpusCase.decisionContextPath !== null) triageProducerInputs.add(corpusCase.decisionContextPath);
      const replayArtifacts = new Set<string>([verdictPath]);
      if (corpusCase.recorded.implementPatchPath !== null) replayArtifacts.add(corpusCase.recorded.implementPatchPath);
      loadedCases.push({
        case: corpusCase,
        snapshot,
        expected,
        decisionContextText,
        triageProducerInputs,
        replayArtifacts,
        scorerOnly: new Set<string>([expectedPath]),
      });
    }
  }

  for (const path of files.keys()) {
    if ((path.startsWith("inputs/") || path.startsWith("expectations/")) && !canonicalPaths.has(path)) {
      errors.push(`${path} is orphaned or non-canonical`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const producerVisiblePaths = new Set<string>(["manifest.json"]);
  const scorerVisiblePaths = new Set<string>();
  for (const loadedCase of loadedCases) {
    loadedCase.triageProducerInputs.forEach((path) => producerVisiblePaths.add(path));
    loadedCase.replayArtifacts.forEach((path) => producerVisiblePaths.add(path));
    loadedCase.scorerOnly.forEach((path) => scorerVisiblePaths.add(path));
  }
  for (const path of producerVisiblePaths) {
    if (path.startsWith("expectations/")) errors.push(`producer-visible path ${path} must not be an expectation`);
    if (scorerVisiblePaths.has(path)) errors.push(`path ${path} is both producer-visible and scorer-visible`);
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { manifest, cases: loadedCases, producerVisiblePaths, scorerVisiblePaths } };
}
