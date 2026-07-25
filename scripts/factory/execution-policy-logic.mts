/**
 * Pure executable-boundary policy analysis for factory issue #120.
 *
 * Workflow and language-specific parsers build this evidence. This module
 * decides only whether source provenance, runner reachability, remote
 * delegation, and data crossings satisfy D117.
 */

const FULL_GITHUB_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REMOTE_ACTION_SHA_PATTERN =
  /^(?![./])(?!(?:[^/@]+\/)*\.{1,2}(?:\/|@))[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/i;
const DATA_FORMATS = new Set(["coverage", "diff", "json", "patch", "review-verdict", "text"]);
/** Global D117 ceiling; activation contracts may impose tighter limits. */
export const MAX_BOUNDARY_ARTIFACT_BYTES = 8_000_000;

/**
 * Evidence that identifies the executable bytes used by one policy step.
 */
export type ExecutionSourceEvidence =
  | {
      readonly kind: "mutable-repository";
      readonly path: string;
    }
  | {
      readonly kind: "protected-glue";
      readonly path: string;
      readonly pathProtected: boolean;
      readonly revisionOrigin: "event-base-sha" | "main-github-sha";
      readonly expectedSha: string;
      readonly observedSha: string;
      readonly restoredObservedShas: readonly string[];
    }
  | {
      readonly kind: "trusted-main-snowflake";
      readonly path: string;
      readonly revisionOrigin: "main-github-sha";
      readonly expectedSha: string;
      readonly observedSha: string;
      readonly restoredObservedShas: readonly string[];
      readonly eventRef: string;
      readonly environmentApproved: boolean;
    }
  | {
      readonly kind: "remote-action";
      readonly reference: string;
    };

/**
 * One executable step and the runner state it can read or mutate.
 */
export interface ExecutionPolicyStep {
  readonly id: string;
  readonly runnerId: string;
  readonly runnerTrust: "fresh-github-hosted" | "persistent-or-unknown";
  readonly credentialReachable: boolean;
  readonly source: ExecutionSourceEvidence;
}

/**
 * Evidence that an artifact is data rather than an executable/config channel.
 */
export interface BoundedDataContractEvidence {
  readonly kind: "bounded";
  readonly format:
    | "coverage"
    | "diff"
    | "json"
    | "patch"
    | "review-verdict"
    | "text";
  readonly allowedNames: readonly string[];
  readonly maxBytes: number;
  readonly rejectUnexpectedNames: boolean;
  readonly rejectUnexpectedTypes: boolean;
  readonly rejectSymlinks: boolean;
  readonly rejectConfiguration: boolean;
  readonly rejectPlugins: boolean;
  readonly rejectHooks: boolean;
  readonly rejectModules: boolean;
  readonly rejectExecutables: boolean;
}

/**
 * A declared data flow between otherwise independent runner states.
 */
export interface ExecutionDataCrossing {
  readonly id: string;
  readonly producer:
    | { readonly kind: "step"; readonly stepId: string }
    | { readonly kind: "untrusted-data"; readonly source: string };
  readonly consumerStepId: string;
  readonly contract?: BoundedDataContractEvidence;
}

/**
 * Complete pure-policy evidence for one workflow or composed execution graph.
 */
export interface ExecutionPolicyEvidence {
  readonly graphComplete: boolean;
  readonly steps: readonly ExecutionPolicyStep[];
  readonly crossings: readonly ExecutionDataCrossing[];
}

/**
 * One fail-closed D117 policy violation.
 */
export interface ExecutionPolicyViolation {
  readonly kind:
    | "invalid-evidence"
    | "invalid-source-provenance"
    | "mutable-execution-reaches-credentials"
    | "unbounded-data-crossing";
  readonly subject: string;
  readonly detail: string;
}

type SourceAssessment =
  | {
      readonly valid: true;
      readonly trusted: boolean;
    }
  | {
      readonly valid: false;
      readonly trusted: false;
      readonly detail: string;
    };

function invalidSource(detail: string): SourceAssessment {
  return { valid: false, trusted: false, detail };
}

function safeRepositoryPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("*"),
  );
}

function exactRevisionMatches(
  expectedSha: string,
  observedSha: string,
  restoredObservedShas: readonly string[],
): boolean {
  if (
    !FULL_GITHUB_SHA_PATTERN.test(expectedSha) ||
    observedSha.toLowerCase() !== expectedSha.toLowerCase()
  ) {
    return false;
  }
  return restoredObservedShas.every(
    (sha) =>
      FULL_GITHUB_SHA_PATTERN.test(sha) &&
      sha.toLowerCase() === expectedSha.toLowerCase(),
  );
}

function assessSource(source: ExecutionSourceEvidence): SourceAssessment {
  if (source.kind === "mutable-repository") {
    return safeRepositoryPath(source.path)
      ? { valid: true, trusted: false }
      : invalidSource("mutable repository path is not a safe relative path");
  }
  if (source.kind === "remote-action") {
    return REMOTE_ACTION_SHA_PATTERN.test(source.reference)
      ? { valid: true, trusted: true }
      : invalidSource("remote action is not pinned to a full GitHub commit SHA");
  }
  if (!safeRepositoryPath(source.path)) {
    return invalidSource("repository source is not a safe relative path");
  }
  if (
    source.revisionOrigin !== "main-github-sha" &&
    (source.kind !== "protected-glue" ||
      source.revisionOrigin !== "event-base-sha")
  ) {
    return invalidSource("repository revision origin is not an approved trusted context");
  }
  if (
    !exactRevisionMatches(
      source.expectedSha,
      source.observedSha,
      source.restoredObservedShas,
    )
  ) {
    return invalidSource("checkout or restored source does not match the expected SHA");
  }
  if (source.kind === "protected-glue") {
    return source.pathProtected
      ? { valid: true, trusted: true }
      : invalidSource("protected-glue source lacks protected-path evidence");
  }
  if (
    !source.path.startsWith("snowflake/") ||
    source.eventRef !== "refs/heads/main" ||
    !source.environmentApproved
  ) {
    return invalidSource(
      "Snowflake source requires snowflake/** on approved refs/heads/main",
    );
  }
  return { valid: true, trusted: true };
}

function contractFailure(
  contract: BoundedDataContractEvidence | undefined,
): string | undefined {
  if (contract === undefined || contract.kind !== "bounded") {
    return "crossing has no bounded data contract";
  }
  if (!DATA_FORMATS.has(contract.format)) {
    return "crossing declares an unsupported data format";
  }
  if (
    contract.allowedNames.length === 0 ||
    new Set(contract.allowedNames).size !== contract.allowedNames.length ||
    contract.allowedNames.some((name) => !safeRepositoryPath(name))
  ) {
    return "crossing does not declare unique safe exact artifact names";
  }
  if (
    !Number.isSafeInteger(contract.maxBytes) ||
    contract.maxBytes <= 0 ||
    contract.maxBytes > MAX_BOUNDARY_ARTIFACT_BYTES
  ) {
    return "crossing byte bound is outside the approved policy ceiling";
  }
  const requiredRejections = [
    contract.rejectUnexpectedNames,
    contract.rejectUnexpectedTypes,
    contract.rejectSymlinks,
    contract.rejectConfiguration,
    contract.rejectPlugins,
    contract.rejectHooks,
    contract.rejectModules,
    contract.rejectExecutables,
  ];
  return requiredRejections.every((value) => value === true)
    ? undefined
    : "crossing contract accepts an executable or unbounded data channel";
}

/**
 * Analyze D117 source, reachability, delegation, and data-boundary evidence.
 *
 * Shared runner state is intentionally order-independent: mutable execution
 * before credentials can poison later state, and mutable execution after
 * credentials can consume state left behind. A distinct runner is a cut only
 * when every declared flow across a credential boundary has a bounded data
 * contract.
 *
 * @param evidence - Closed execution graph produced by later slice analyzers.
 * @returns Deterministic fail-closed policy violations.
 */
export function analyzeExecutionPolicy(
  evidence: ExecutionPolicyEvidence,
): readonly ExecutionPolicyViolation[] {
  const violations: ExecutionPolicyViolation[] = [];
  if (!evidence.graphComplete) {
    violations.push({
      kind: "invalid-evidence",
      subject: "<execution-graph>",
      detail: "execution graph completeness has not been proven",
    });
  }
  const stepById = new Map<string, ExecutionPolicyStep>();
  const sourceById = new Map<string, SourceAssessment>();

  for (const step of evidence.steps) {
    if (
      step.id.length === 0 ||
      step.id.trim() !== step.id ||
      step.runnerId.length === 0 ||
      step.runnerId.trim() !== step.runnerId ||
      stepById.has(step.id)
    ) {
      violations.push({
        kind: "invalid-evidence",
        subject: step.id || "<empty-step-id>",
        detail: "step and runner IDs must be unique non-empty canonical text",
      });
      continue;
    }
    stepById.set(step.id, step);
    const assessment = assessSource(step.source);
    sourceById.set(step.id, assessment);
    if (!assessment.valid) {
      violations.push({
        kind: "invalid-source-provenance",
        subject: step.id,
        detail: assessment.detail,
      });
    }
  }

  const credentialRunners = new Set(
    [...stepById.values()]
      .filter((step) => step.credentialReachable)
      .map((step) => step.runnerId),
  );
  for (const step of stepById.values()) {
    if (
      credentialRunners.has(step.runnerId) &&
      step.runnerTrust !== "fresh-github-hosted"
    ) {
      violations.push({
        kind: "invalid-evidence",
        subject: step.id,
        detail: "credential runner is not proven fresh and GitHub-hosted",
      });
    }
    const source = sourceById.get(step.id);
    if (
      source?.valid === true &&
      !source.trusted &&
      credentialRunners.has(step.runnerId)
    ) {
      violations.push({
        kind: "mutable-execution-reaches-credentials",
        subject: step.id,
        detail: `mutable execution shares runner "${step.runnerId}" with reachable credentials`,
      });
    }
  }

  const crossingIds = new Set<string>();
  for (const crossing of evidence.crossings) {
    if (
      crossing.id.length === 0 ||
      crossing.id.trim() !== crossing.id ||
      crossingIds.has(crossing.id) ||
      (crossing.producer.kind === "untrusted-data" &&
        crossing.producer.source.trim().length === 0)
    ) {
      violations.push({
        kind: "invalid-evidence",
        subject: crossing.id || "<empty-crossing-id>",
        detail: "data crossing identity must be unique non-empty canonical text",
      });
      continue;
    }
    crossingIds.add(crossing.id);
    const producer =
      crossing.producer.kind === "step"
        ? stepById.get(crossing.producer.stepId)
        : undefined;
    const consumer = stepById.get(crossing.consumerStepId);
    if (
      (crossing.producer.kind === "step" && producer === undefined) ||
      consumer === undefined
    ) {
      violations.push({
        kind: "invalid-evidence",
        subject: crossing.id,
        detail: "data crossing references an unknown execution step",
      });
      continue;
    }
    if (
      (producer !== undefined &&
        producer.runnerId === consumer.runnerId) ||
      (producer !== undefined &&
        !credentialRunners.has(producer.runnerId) &&
        !credentialRunners.has(consumer.runnerId)) ||
      (producer === undefined &&
        !credentialRunners.has(consumer.runnerId))
    ) {
      continue;
    }
    const failure = contractFailure(crossing.contract);
    if (failure !== undefined) {
      violations.push({
        kind: "unbounded-data-crossing",
        subject: crossing.id,
        detail: failure,
      });
    }
  }

  return violations;
}
