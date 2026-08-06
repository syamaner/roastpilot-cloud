export const MAX_MANIFEST_BYTES = 512_000;
export const REVIEW_LENSES = [
  "ci", "codeql", "mutation-gate", "dependency-review", "codecov",
  "codex-connector", "codex-local-review", "claude-code-review",
  "spec-grounded-review", "factory-security-reviewer",
  "schema-migration-reviewer", "privacy-auditor", "qa", "pr-triage", "human",
] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];
export type IssueType = "feature" | "security-fix" | "hardening" | "documentation" | "migration" | "schema";
export interface ReviewFinding { readonly lens: ReviewLens; readonly severity: "blocker" | "medium" | "low"; readonly description: string; readonly counterfactual: "downstream-gate-would-catch" | "unique-to-lens" | "unassessed" }
export interface LensCost { readonly lens: ReviewLens; readonly tokens: number | null; readonly wallClockSeconds: number | null }
export interface FactoryPrRecord {
  readonly prNumber: number; readonly headSha: string; readonly issueNumber: number;
  readonly issueType: IssueType; readonly execution: "factory" | "conventional";
  readonly securitySurface: boolean; readonly triageOverridden: boolean;
  readonly firstPassCiGreen: boolean; readonly postOpenReviewRounds: number;
  readonly humanTouchMinutes: number; readonly reviewFindings: readonly ReviewFinding[];
  readonly lensCosts: readonly LensCost[]; readonly sampledForAudit: boolean;
}
export interface BaselineManifest { readonly schemaVersion: 1; readonly description: string; readonly records: readonly FactoryPrRecord[] }
export interface AuditLedgerEntry { readonly prNumber: number; readonly auditor: string; readonly performedAt: string; readonly outcome: "clean" | "findings-fixed" | "escape" }
export interface AuditLedger { readonly schemaVersion: 1; readonly entries: readonly AuditLedgerEntry[] }
export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

export const REQUIRED_RECORD_FIELDS = [
  "prNumber", "headSha", "issueNumber", "issueType", "execution",
  "securitySurface", "triageOverridden", "firstPassCiGreen",
  "postOpenReviewRounds", "humanTouchMinutes", "reviewFindings", "lensCosts",
  "sampledForAudit",
] as const;

type Validator = (value: unknown, path: string, errors: string[]) => void;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = (allowed: readonly string[]): Validator => (value, path, errors) => { if (typeof value !== "string" || !allowed.includes(value)) errors.push(`${path} must be one of ${allowed.join(", ")}`); };
const boolean: Validator = (value, path, errors) => { if (typeof value !== "boolean") errors.push(`${path} must be a boolean`); };
const positiveInteger: Validator = (value, path, errors) => { if (!Number.isInteger(value) || (value as number) <= 0) errors.push(`${path} must be a positive integer`); };
const nonnegativeInteger: Validator = (value, path, errors) => { if (!Number.isInteger(value) || (value as number) < 0) errors.push(`${path} must be a non-negative integer`); };
const nonnegativeFinite: Validator = (value, path, errors) => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${path} must be a non-negative finite number`); };
const boundedString = (maximum: number): Validator => (value, path, errors) => { if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) errors.push(`${path} must be a non-empty string of at most ${maximum} characters`); };

function closed(value: unknown, path: string, fields: readonly string[], validators: Readonly<Record<string, Validator>>, errors: string[]): void {
  if (!object(value)) { errors.push(`${path} must be an object`); return; }
  const extras = Object.keys(value).filter((key) => !fields.includes(key));
  if (extras.length) errors.push(`${path} has unexpected key(s): ${extras.join(", ")}`);
  for (const field of fields) {
    if (!own(value, field)) errors.push(`${path}.${field} is required`);
    else validators[field](value[field], `${path}.${field}`, errors);
  }
}

const findingFields = ["lens", "severity", "description", "counterfactual"] as const;
const findingValidators: Readonly<Record<(typeof findingFields)[number], Validator>> = {
  lens: oneOf(REVIEW_LENSES), severity: oneOf(["blocker", "medium", "low"]),
  description: boundedString(500),
  counterfactual: oneOf(["downstream-gate-would-catch", "unique-to-lens", "unassessed"]),
};
const costFields = ["lens", "tokens", "wallClockSeconds"] as const;
const nullableCost: Validator = (value, path, errors) => { if (value !== null) nonnegativeFinite(value, path, errors); if (value !== null && !Number.isInteger(value) && path.endsWith("tokens")) errors.push(`${path} must be an integer or null`); };
const costValidators: Readonly<Record<(typeof costFields)[number], Validator>> = { lens: oneOf(REVIEW_LENSES), tokens: nullableCost, wallClockSeconds: (value, path, errors) => { if (value !== null) nonnegativeFinite(value, path, errors); } };
const arrayOf = (validate: (value: unknown, path: string, errors: string[]) => void): Validator => (value, path, errors) => { if (!Array.isArray(value)) errors.push(`${path} must be an array`); else value.forEach((entry, index) => validate(entry, `${path}[${index}]`, errors)); };
const recordValidators: Readonly<Record<(typeof REQUIRED_RECORD_FIELDS)[number], Validator>> = {
  prNumber: positiveInteger, headSha: (value, path, errors) => { if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) errors.push(`${path} must be a 40-hex SHA`); },
  issueNumber: positiveInteger, issueType: oneOf(["feature", "security-fix", "hardening", "documentation", "migration", "schema"]), execution: oneOf(["factory", "conventional"]),
  securitySurface: boolean, triageOverridden: boolean, firstPassCiGreen: boolean,
  postOpenReviewRounds: nonnegativeInteger, humanTouchMinutes: nonnegativeFinite,
  reviewFindings: arrayOf((value, path, errors) => closed(value, path, findingFields, findingValidators, errors)),
  lensCosts: arrayOf((value, path, errors) => closed(value, path, costFields, costValidators, errors)), sampledForAudit: boolean,
};

function parseJson(text: string, label: string): ParseResult<unknown> {
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) return { ok: false, errors: [`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`] };
  try { return { ok: true, value: JSON.parse(text) as unknown }; }
  catch { return { ok: false, errors: [`${label} is invalid JSON`] }; }
}

export function parseManifest(text: string): ParseResult<BaselineManifest> {
  const parsed = parseJson(text, "manifest"); if (!parsed.ok) return parsed;
  const errors: string[] = []; const top = parsed.value;
  const validators: Readonly<Record<string, Validator>> = {
    schemaVersion: (value, path, found) => { if (value !== 1) found.push(`${path} must be literal 1`); },
    description: (value, path, found) => { if (typeof value !== "string") found.push(`${path} must be a string`); },
    records: arrayOf((value, path, found) => closed(value, path, REQUIRED_RECORD_FIELDS, recordValidators, found)),
  };
  closed(top, "manifest", ["schemaVersion", "description", "records"], validators, errors);
  if (object(top) && Array.isArray(top.records)) {
    const seen = new Set<number>(); top.records.forEach((entry, index) => { if (object(entry) && Number.isInteger(entry.prNumber) && (entry.prNumber as number) > 0) { const pr = entry.prNumber as number; if (seen.has(pr)) errors.push(`manifest.records[${index}].prNumber duplicates ${pr}`); seen.add(pr); } });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: top as unknown as BaselineManifest };
}

export function parseLedger(text: string): ParseResult<AuditLedger> {
  const parsed = parseJson(text, "ledger"); if (!parsed.ok) return parsed;
  const errors: string[] = []; const fields = ["prNumber", "auditor", "performedAt", "outcome"] as const;
  const entryValidators: Readonly<Record<(typeof fields)[number], Validator>> = {
    prNumber: positiveInteger, auditor: boundedString(100),
    performedAt: (value, path, found) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) { found.push(`${path} must be a UTC second timestamp`); return; }
      const date = new Date(value);
      if (Number.isNaN(date.getTime()) || `${date.toISOString().slice(0, 19)}Z` !== value) found.push(`${path} must be a real UTC second timestamp`);
    },
    outcome: oneOf(["clean", "findings-fixed", "escape"]),
  };
  closed(parsed.value, "ledger", ["schemaVersion", "entries"], {
    schemaVersion: (value, path, found) => { if (value !== 1) found.push(`${path} must be literal 1`); },
    entries: arrayOf((value, path, found) => closed(value, path, fields, entryValidators, found)),
  }, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.value as unknown as AuditLedger };
}
