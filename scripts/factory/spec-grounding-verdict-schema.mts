/**
 * The spec-grounded review verdict JSON contract (F1-S9 slice 3b-ii-b,
 * issue #12).
 *
 * The read-only review-agent job slice 3b-ii-c wires up writes a verdict
 * of this shape to a file (via the ONE narrow `Edit` grant its tool
 * policy allows); the privileged step in slice 3b-iii (not yet built)
 * reads that file back and MUST run it through
 * {@link validateSpecGroundingVerdict} before acting on it. Mirrors
 * `triage-verdict-schema.mts`'s shape and discipline exactly: nothing
 * here calls the network or touches the filesystem, so it is pure and
 * directly unit-testable against adversarial input (a prompt-injected or
 * malformed verdict must be rejected, never acted on).
 *
 * DELIBERATELY MINIMAL, per team-lead's Q2 hardening refinement (the #12
 * 3b PR-plan sign-off, carried through slice 3b-i's trusted spine and
 * now this schema): the agent contributes ONLY `criterionId`,
 * `satisfied`, and `rationale` per finding — no `kind`, no severity. Both
 * of those are re-derived downstream, in slice 3b-iii, from the RUNNER's
 * own trusted `criteria-spine.json` (already merged, `spec-grounding-
 * runner-logic.mts`'s `buildCriteriaSpine`), joined by `criterionId` —
 * never accepted from the agent's own output. An agent that tried to
 * smuggle a `kind`/`severity` field into a finding is REJECTED outright
 * by this validator (an unknown-key error), not silently stripped — see
 * {@link ALLOWED_FINDING_KEYS}'s own docstring for why rejection, not
 * silent tolerance, is the safer failure mode here.
 *
 * This module does NOT read `criteria-spine.json` and does NOT know
 * which `criterionId` values are actually real for a given run — that
 * cross-check (a spine ID the agent's output omits defaults to
 * `satisfied: false`; a `criterionId` the agent invents that was never
 * in the spine at all is simply irrelevant, never looked up) is slice
 * 3b-iii's join logic, deliberately kept separate from this module the
 * same way `triage-verdict-schema.mts`'s format validation stays separate
 * from `apply-triage-verdict-logic.mts`'s label-computation logic.
 */

/**
 * Upper bound on the number of findings a verdict may contain. Set to
 * match the trusted spine's own theoretical maximum size —
 * `spec-grounding-logic.mts`'s `MAX_LINKED_ISSUES` (20) times
 * `MAX_CRITERIA_PER_ISSUE` (50) — WITHOUT importing those constants (this
 * module stays zero-dependency and self-contained, matching
 * `triage-verdict-schema.mts`'s own precedent); if either upstream cap
 * ever changes, this constant is independently reviewable, not silently
 * coupled to a value defined elsewhere.
 */
export const MAX_FINDINGS = 1000;

/**
 * Upper bound on `rationale` length, in characters, per finding. Slightly
 * more generous than `triage-verdict-schema.mts`'s `MAX_REASONING_LENGTH`
 * (4000) since a rationale may reasonably quote a short diff snippet
 * alongside its own reasoning.
 */
export const MAX_RATIONALE_LENGTH = 2000;

/**
 * Upper bound on `criterionId` length, in characters. The runner's own
 * `criterionId` shape (`${issueNumber}:${index}`, `spec-grounding-runner-
 * logic.mts`'s `buildCriteriaSpine`) is always short — this is a generous
 * ceiling against a runaway or adversarial value, not a tight fit to the
 * expected shape (see {@link CRITERION_ID_PATTERN} for the actual shape
 * check).
 */
export const MAX_CRITERION_ID_LENGTH = 32;

/**
 * Upper bound on the serialized verdict size, in UTF-8 bytes. Guards
 * against a runaway or adversarial payload before any of the field-level
 * checks below even run — same resource-exhaustion reasoning as
 * `triage-verdict-schema.mts`'s own `MAX_PAYLOAD_BYTES`.
 *
 * Sized above the worst-case LEGITIMATE total under the per-field caps
 * above — computed with the ENCODING actually in play, not
 * `rationale.length` directly (Codex finding, PR #74 review: an earlier
 * version of this constant added the per-field caps as if `.length`
 * (UTF-16 code units) equalled serialized UTF-8 bytes, which
 * undercounted the true worst case and made the documented "sized above
 * the worst-case legitimate total" claim false — a maximal-but-legitimate
 * verdict could be rejected here before its own per-field checks ever
 * ran):
 *
 * - `rationale` is capped at `MAX_RATIONALE_LENGTH` (2000) UTF-16 code
 *   units, not bytes. A single UTF-16 code unit's WORST-CASE UTF-8
 *   encoding is 3 bytes — every BMP code point up to U+FFFF (which
 *   includes the whole CJK Unified Ideographs block, one UTF-16 unit
 *   each) encodes to at most 3 UTF-8 bytes; a surrogate pair (2 UTF-16
 *   units) encodes to 4 UTF-8 bytes, i.e. 2 bytes/unit, strictly less. So
 *   `MAX_RATIONALE_LENGTH × 3` (6,000 bytes) is the true per-finding
 *   worst case for this field alone, not `MAX_RATIONALE_LENGTH × 1`.
 * - `criterionId` is capped at `MAX_CRITERION_ID_LENGTH` (32) characters,
 *   plain ASCII by {@link CRITERION_ID_PATTERN}'s own shape — 1 byte each
 *   either way, no JSON-escaping surface.
 * - Per-finding JSON structural overhead (`{"criterionId":"…","satisfied":
 *   false,"rationale":"…"}`, the `,`/`[`/`]` around the array, and the
 *   top-level `{"findings":…}` wrapper) adds a fixed, small overhead per
 *   entry — measured directly (see this constant's own boundary test)
 *   rather than hand-derived, since JSON-escaping cost varies by content
 *   (a quote-heavy rationale escapes to 2 bytes/char, LESS than a CJK
 *   rationale's 3 bytes/char, so CJK is the dominant worst case here, not
 *   quotes).
 *
 * `MAX_FINDINGS` (1000) × the true CJK worst case measured this way is
 * ~6,084,014 bytes (~6.08MB) — verified directly by constructing that
 * exact payload and measuring `Buffer.byteLength(JSON.stringify(…),
 * "utf8")` (this constant's own boundary test does the same
 * construction). `8,000,000` keeps a real margin above that measured
 * figure while staying a trivial size to parse, so it remains a genuine
 * parse-cost bound rather than a tight fit that could itself start
 * rejecting legitimate verdicts if wording or content shifts slightly.
 */
export const MAX_PAYLOAD_BYTES = 8_000_000;

/**
 * The exact shape `spec-grounding-runner-logic.mts`'s `buildCriteriaSpine`
 * constructs (`${issueNumber}:${index}`) — validated independently here
 * (this module does not import that one, matching the zero-dependency
 * precedent above) so a `criterionId` that isn't even SHAPED like a real
 * one is rejected at the syntactic level, before slice 3b-iii's semantic
 * cross-check (does this ID actually exist in THIS run's spine) ever
 * runs.
 */
const CRITERION_ID_PATTERN = /^\d+:\d+$/;

/** One finding the review agent contributed for one spine criterion. */
export interface SpecGroundingFinding {
  /** Must match `CRITERION_ID_PATTERN`; not cross-checked against a real spine here — see this module's own top-level docstring. */
  readonly criterionId: string;
  /**
   * The agent's own judgment for this criterion, and ONLY this criterion
   * — never a `kind` or severity value; those are trusted-spine-derived,
   * downstream, in slice 3b-iii.
   */
  readonly satisfied: boolean;
  readonly rationale: string;
}

/** A verdict that has passed {@link validateSpecGroundingVerdict}. */
export interface SpecGroundingVerdict {
  readonly findings: readonly SpecGroundingFinding[];
}

export type SpecGroundingVerdictValidationResult =
  | { readonly ok: true; readonly verdict: SpecGroundingVerdict }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The exact set of top-level keys a verdict may contain — no more, no less. */
const ALLOWED_TOP_LEVEL_KEYS = new Set<string>(["findings"]);

/**
 * The exact set of keys ONE finding may contain — no more, no less.
 *
 * Deliberately REJECTS the whole verdict (an unknown-key error, same as
 * `triage-verdict-schema.mts`'s own top-level key check) rather than
 * silently stripping an unexpected key, if the agent's own output
 * includes anything beyond these three — most importantly `kind` or any
 * severity-shaped field. Team-lead's Q2 hardening refinement is that the
 * agent must never be ABLE to self-grade a finding's severity; silently
 * tolerating (and discarding) a `kind`/severity field the agent tried to
 * supply would still leave a class of bug reachable — a FUTURE version of
 * slice 3b-iii's join logic that forgets to actually re-derive `kind` and
 * instead trusts whatever survived validation would silently reopen the
 * exact self-grading gap this whole design exists to close. Rejecting the
 * verdict outright here means that mistake fails LOUD (a validation
 * error, a red run) rather than silently.
 */
const ALLOWED_FINDING_KEYS = new Set<string>(["criterionId", "satisfied", "rationale"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates one finding entry, appending any violation to `errors`
 * (never stopping at the first error, so a caller sees every problem in
 * one pass — same discipline as `triage-verdict-schema.mts`).
 *
 * @param raw - The candidate finding value.
 * @param index - This finding's position in the `findings` array, used
 *   only to make error messages locatable.
 * @param errors - Accumulator every violation is pushed onto.
 * @returns The validated finding, or `null` if `raw` itself isn't even a
 *   plain object (in which case no further per-field checks are
 *   meaningful).
 */
function validateFinding(
  raw: unknown,
  index: number,
  errors: string[],
): SpecGroundingFinding | null {
  if (!isPlainObject(raw)) {
    errors.push(
      `findings[${index}] must be a JSON object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
    return null;
  }

  const unknownKeys = Object.keys(raw).filter((k) => !ALLOWED_FINDING_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`findings[${index}] has unexpected key(s): ${unknownKeys.join(", ")}`);
  }

  const criterionId = raw.criterionId;
  let validCriterionId: string | null = null;
  if (typeof criterionId !== "string" || criterionId.length === 0) {
    errors.push(`findings[${index}].criterionId must be a non-empty string, got ${JSON.stringify(criterionId)}`);
  } else if (criterionId.length > MAX_CRITERION_ID_LENGTH) {
    errors.push(
      `findings[${index}].criterionId exceeds ${MAX_CRITERION_ID_LENGTH} characters (${criterionId.length})`,
    );
  } else if (!CRITERION_ID_PATTERN.test(criterionId)) {
    errors.push(
      `findings[${index}].criterionId must match the shape "<issueNumber>:<index>", got ${JSON.stringify(criterionId)}`,
    );
  } else {
    validCriterionId = criterionId;
  }

  const satisfied = raw.satisfied;
  if (typeof satisfied !== "boolean") {
    errors.push(`findings[${index}].satisfied must be a boolean, got ${JSON.stringify(satisfied)}`);
  }

  const rationale = raw.rationale;
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    errors.push(`findings[${index}].rationale must be a non-empty string`);
  } else if (rationale.length > MAX_RATIONALE_LENGTH) {
    errors.push(`findings[${index}].rationale exceeds ${MAX_RATIONALE_LENGTH} characters (${rationale.length})`);
  }

  if (
    validCriterionId === null ||
    typeof satisfied !== "boolean" ||
    typeof rationale !== "string" ||
    rationale.trim().length === 0 ||
    rationale.length > MAX_RATIONALE_LENGTH
  ) {
    return null;
  }

  return { criterionId: validCriterionId, satisfied, rationale };
}

/**
 * Validates a raw (untrusted, possibly prompt-injected) spec-grounding
 * verdict against the JSON contract described above.
 *
 * @param raw - The parsed JSON value read from the verdict artifact slice
 *   3b-ii-c's read-only review agent wrote.
 * @returns A discriminated result: `{ ok: true, verdict }` with a verdict
 *   safe for slice 3b-iii to join against the trusted spine, or
 *   `{ ok: false, errors }` listing every violation found.
 */
export function validateSpecGroundingVerdict(raw: unknown): SpecGroundingVerdictValidationResult {
  const errors: string[] = [];

  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  } catch {
    payloadBytes = Number.POSITIVE_INFINITY;
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    errors.push(`payload too large: ${payloadBytes} bytes exceeds ${MAX_PAYLOAD_BYTES}`);
    // A payload this size is not worth inspecting field-by-field further.
    return { ok: false, errors };
  }

  if (!isPlainObject(raw)) {
    errors.push(
      `verdict must be a JSON object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
    return { ok: false, errors };
  }

  const unknownKeys = Object.keys(raw).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`unexpected key(s): ${unknownKeys.join(", ")}`);
  }

  const findingsRaw = raw.findings;
  if (!Array.isArray(findingsRaw)) {
    errors.push(`findings must be an array, got ${JSON.stringify(findingsRaw)}`);
    return { ok: false, errors };
  }

  if (findingsRaw.length > MAX_FINDINGS) {
    errors.push(`findings has ${findingsRaw.length} entries, exceeds ${MAX_FINDINGS}`);
    return { ok: false, errors };
  }

  const seenCriterionIds = new Set<string>();
  const validatedFindings: SpecGroundingFinding[] = [];
  findingsRaw.forEach((entry: unknown, index: number) => {
    const finding = validateFinding(entry, index, errors);
    if (finding === null) {
      return;
    }
    if (seenCriterionIds.has(finding.criterionId)) {
      // Ambiguous input (Codex-class finding, this module's own design):
      // rejecting a duplicate outright, rather than picking an arbitrary
      // first-wins/last-wins resolution, keeps slice 3b-iii's join simple
      // (safe to build a Map from criterionId with no race to resolve)
      // and fails closed on genuinely malformed input instead of
      // silently guessing at the agent's intent.
      errors.push(`findings[${index}].criterionId "${finding.criterionId}" is a duplicate`);
      return;
    }
    seenCriterionIds.add(finding.criterionId);
    validatedFindings.push(finding);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, verdict: { findings: validatedFindings } };
}
