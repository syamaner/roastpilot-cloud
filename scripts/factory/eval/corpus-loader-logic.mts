import {
  ANSWER_VERDICT_TOKENS,
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
  readonly recordedTriageVerdictText: string;
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
  if (text.length === 0) {
    errors.push(`${path} is empty`);
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

function scanInputAnswerNeutrality(
  corpusCase: CorpusCase,
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
}

function noteManifestLeak(
  surface: string,
  text: string,
  token: string,
  errors: string[],
): void {
  if (containsDelimiterBoundedToken(text, token)) {
    errors.push(`${surface} leaks answer-verdict token ${token}`);
  }
}

function scanManifestStrings(
  value: unknown,
  surface: string,
  tokens: ReadonlySet<string>,
  errors: string[],
): void {
  if (typeof value === "string") {
    for (const token of tokens) noteManifestLeak(surface, value, token, errors);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nestedValue] of Object.entries(value)) {
    scanManifestStrings(nestedValue, `${surface}.${key}`, tokens, errors);
  }
}

export function assembleCorpus(
  manifestText: string,
  files: ReadonlyMap<string, string>,
): LoadResult {
  const errors: string[] = [];
  const manifestRaw = parseBoundedJson(manifestText, MAX_MANIFEST_BYTES, "manifest.json", errors);
  if (manifestRaw === undefined) return { ok: false, errors };
  const manifestResult = validateCorpusManifest(manifestRaw);
  if (!manifestResult.ok) {
    errors.push(...manifestResult.errors);
    return { ok: false, errors };
  }
  const manifest = manifestResult.value;

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

    const snapshotText = requiredText(
      files,
      snapshotPath,
      MAX_SNAPSHOT_BYTES,
      caseErrors,
    );
    let snapshot: IssueSnapshot | undefined;
    if (snapshotText !== undefined) {
      const snapshotRaw = parseBoundedJson(snapshotText, MAX_SNAPSHOT_BYTES, snapshotPath, caseErrors);
      if (snapshotRaw !== undefined) {
        const result = validateIssueSnapshot(snapshotRaw);
        if (!result.ok) caseErrors.push(...result.errors.map((error) => `${snapshotPath}: ${error}`));
        else {
          snapshot = result.value;
          if (snapshot.issueNumber !== corpusCase.issueNumber) caseErrors.push(`${snapshotPath} issueNumber does not match manifest case ${corpusCase.caseId}`);
          if (snapshot.snapshotAt > corpusCase.capturedAt) caseErrors.push(`${corpusCase.caseId} snapshotAt is later than capturedAt`);
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

    const recordedTriageVerdictText = requiredText(files, verdictPath, MAX_PAYLOAD_BYTES, caseErrors);

    let patchText: string | null = null;
    const canonicalPatchPath = `inputs/${corpusCase.caseId}/recorded/implement.patch`;
    if (corpusCase.recorded.implementPatchPath === null) {
      if (files.has(canonicalPatchPath)) caseErrors.push(`${canonicalPatchPath} is present while implementPatchPath is null`);
    } else {
      canonicalPaths.add(corpusCase.recorded.implementPatchPath);
      patchText = requiredText(files, corpusCase.recorded.implementPatchPath, MAX_RECORDED_PATCH_BYTES, caseErrors) ?? null;
    }

    let expected: ExpectedResult | undefined;
    const expectedText = requiredText(
      files,
      expectedPath,
      MAX_EXPECTED_BYTES,
      caseErrors,
    );
    if (expectedText !== undefined) {
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
      scanInputAnswerNeutrality(corpusCase, snapshot, expected, decisionContextText, patchText, caseErrors);
    }

    errors.push(...caseErrors);
    if (caseErrors.length === 0 && snapshot !== undefined && expected !== undefined && recordedTriageVerdictText !== undefined) {
      const triageProducerInputs = new Set<string>([snapshotPath]);
      if (corpusCase.decisionContextPath !== null) triageProducerInputs.add(corpusCase.decisionContextPath);
      const replayArtifacts = new Set<string>([verdictPath]);
      if (corpusCase.recorded.implementPatchPath !== null) replayArtifacts.add(corpusCase.recorded.implementPatchPath);
      loadedCases.push({
        case: corpusCase,
        snapshot,
        expected,
        decisionContextText,
        recordedTriageVerdictText,
        triageProducerInputs,
        replayArtifacts,
        scorerOnly: new Set<string>([expectedPath]),
      });
    }
  }

  for (const corpusCase of manifest.cases) {
    scanManifestStrings(corpusCase, `${corpusCase.caseId} manifest.case`, ANSWER_VERDICT_TOKENS, errors);
  }
  for (const token of ANSWER_VERDICT_TOKENS) {
    noteManifestLeak("manifest.description", manifest.description, token, errors);
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
    /* v8 ignore next -- unreachable: producer set is built solely from manifest/inputs paths, never expectations paths */
    if (path.startsWith("expectations/")) errors.push(`producer-visible path ${path} must not be an expectation`);
    /* v8 ignore next -- unreachable: producer and scorer sets are built from disjoint canonical path families */
    if (scorerVisiblePaths.has(path)) errors.push(`path ${path} is both producer-visible and scorer-visible`);
  }
  /* v8 ignore next -- unreachable: the construction-only assertions above cannot add an error */
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { manifest, cases: loadedCases, producerVisiblePaths, scorerVisiblePaths } };
}
