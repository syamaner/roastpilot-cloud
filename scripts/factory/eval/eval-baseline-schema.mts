import {
  CASE_ID_PATTERN,
  ISSUE_TYPES,
} from "./expected-result-schema.mts";
import {
  isPlainObject,
  unexpectedKeys,
  type ValidationResult,
} from "./validation-common.mts";

export const MAX_BASELINE_BYTES = 65_536;
export const TRIAGE_ONLY_DIMENSIONS = ["triageLabel"] as const;
export const IMPLEMENT_DIMENSIONS = [
  "compile",
  "diffBound",
  "mutation",
  "tests",
  "triageLabel",
] as const;

export interface EvalBaseline {
  readonly schemaVersion: 1;
  readonly corpus: {
    readonly corpusSha256: string;
    readonly caseIds: readonly string[];
  };
  readonly cases: readonly {
    readonly caseId: string;
    readonly issueType: (typeof ISSUE_TYPES)[number];
    readonly dimensions: readonly string[];
  }[];
}

const TOP_LEVEL_KEYS = new Set<string>([
  "schemaVersion",
  "corpus",
  "cases",
]);
const CORPUS_KEYS = new Set<string>(["corpusSha256", "caseIds"]);
const CASE_KEYS = new Set<string>(["caseId", "issueType", "dimensions"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function closedObject(
  raw: unknown,
  path: string,
  keys: ReadonlySet<string>,
  errors: string[],
): raw is Record<string, unknown> {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const unknown = unexpectedKeys(raw, keys);
  if (unknown.length > 0) {
    errors.push(`${path} has unexpected key(s): ${unknown.join(", ")}`);
  }
  return true;
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateCaseIds(raw: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("baseline.corpus.caseIds must be a non-empty array");
    return null;
  }
  const caseIds: string[] = [];
  raw.forEach((value: unknown, index: number) => {
    if (typeof value !== "string" || !CASE_ID_PATTERN.test(value)) {
      errors.push(
        `baseline.corpus.caseIds[${String(index)}] must match the corpus case-id pattern`,
      );
      return;
    }
    caseIds.push(value);
  });
  if (
    caseIds.length === raw.length &&
    caseIds.some((value, index) => index > 0 && value <= caseIds[index - 1])
  ) {
    errors.push("baseline.corpus.caseIds must be strictly ascending");
  }
  return caseIds.length === raw.length ? caseIds : null;
}

function validateDimensions(
  raw: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    errors.push(`${path} must be an array of strings`);
    return;
  }
  if (
    !sameOrderedStrings(raw, TRIAGE_ONLY_DIMENSIONS) &&
    !sameOrderedStrings(raw, IMPLEMENT_DIMENSIONS)
  ) {
    errors.push(
      `${path} must byte-equal a recorded evaluation dimension set`,
    );
  }
}

function validateCases(raw: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push("baseline.cases must be an array");
    return null;
  }
  const caseIds: string[] = [];
  raw.forEach((entry: unknown, index: number) => {
    const path = `baseline.cases[${String(index)}]`;
    if (!closedObject(entry, path, CASE_KEYS, errors)) return;
    if (typeof entry.caseId !== "string" || !CASE_ID_PATTERN.test(entry.caseId)) {
      errors.push(`${path}.caseId must match the corpus case-id pattern`);
    } else {
      caseIds.push(entry.caseId);
    }
    if (
      typeof entry.issueType !== "string" ||
      !(ISSUE_TYPES as readonly string[]).includes(entry.issueType)
    ) {
      errors.push(`${path}.issueType must be a known issue type`);
    }
    validateDimensions(entry.dimensions, `${path}.dimensions`, errors);
  });
  if (
    caseIds.length === raw.length &&
    caseIds.some((value, index) => index > 0 && value <= caseIds[index - 1])
  ) {
    errors.push("baseline.cases must be strictly ascending by caseId");
  }
  return caseIds.length === raw.length ? caseIds : null;
}

/**
 * Validates a parsed baseline without I/O. The caller must reject UTF-8 text
 * over MAX_BASELINE_BYTES before parsing and calling this function.
 */
export function validateEvalBaseline(
  raw: unknown,
): ValidationResult<EvalBaseline> {
  const errors: string[] = [];
  try {
    if (!closedObject(raw, "baseline", TOP_LEVEL_KEYS, errors)) {
      return { ok: false, errors };
    }
    if (raw.schemaVersion !== 1) {
      errors.push("baseline.schemaVersion must be the integer 1");
    }

    let corpusCaseIds: string[] | null = null;
    if (closedObject(raw.corpus, "baseline.corpus", CORPUS_KEYS, errors)) {
      if (
        typeof raw.corpus.corpusSha256 !== "string" ||
        !SHA256_PATTERN.test(raw.corpus.corpusSha256)
      ) {
        errors.push(
          "baseline.corpus.corpusSha256 must be a lowercase 64-hex SHA-256",
        );
      }
      corpusCaseIds = validateCaseIds(raw.corpus.caseIds, errors);
    }

    const caseIds = validateCases(raw.cases, errors);
    if (
      corpusCaseIds !== null &&
      caseIds !== null &&
      !sameOrderedStrings(caseIds, corpusCaseIds)
    ) {
      errors.push(
        "baseline.cases caseId list must byte-equal baseline.corpus.caseIds",
      );
    }

    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, value: raw as unknown as EvalBaseline };
  } catch {
    errors.push("baseline is not inspectable");
    return { ok: false, errors };
  }
}
