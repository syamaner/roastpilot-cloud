/**
 * The spec-grounded review verdict JSON contract (F1-S9 slice 3b-ii-b,
 * issue #12).
 *
 * The read-only review-agent job slice 3b-ii-c wires up writes a verdict
 * of this shape to a file (via the ONE narrow `Edit` grant its tool
 * policy allows); the privileged step in slice 3b-iii (not yet built)
 * reads that file back and MUST run it through
 * {@link parseAndValidateVerdict} — THE entry point for reading the raw
 * artifact — before acting on it (see that function's own docstring for
 * why the RAW-bytes check it does before parsing is not optional;
 * {@link validateSpecGroundingVerdict} alone, on an already-parsed value,
 * cannot bound the cost of parsing itself). Mirrors
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
 *   rather than hand-derived, since JSON-escaping cost varies by content.
 *
 * A rationale's WORST-CASE escaping cost is bounded by CONTENT, not just
 * length, and this constant's derivation only holds for content this
 * module actually allows (Codex finding, PR #74 review round 2, FOLD 1 —
 * a real gap one level deeper than the first fold: a raw control
 * character or an unpaired surrogate `JSON.stringify`s to a 6-byte
 * `\uXXXX` escape, WORSE than a CJK character's 3-bytes-per-unit worst
 * case, so a rationale satisfying every field-level cap as originally
 * written could still push the true total past `MAX_PAYLOAD_BYTES` —
 * `MAX_FINDINGS` × `MAX_RATIONALE_LENGTH` control characters ≈ 12.1MB.
 * Rather than chase the ceiling to match that, {@link hasDisallowedControlCharacter}
 * and {@link hasUnpairedSurrogate} now reject that content at the field
 * level — content no legitimate agent rationale would ever contain
 * anyway). With that content excluded, the CJK case (one UTF-16 unit,
 * the maximum 3 UTF-8 bytes) is the true worst LEGAL payload:
 * `MAX_FINDINGS` (1000) × that measured worst case is ~6,084,014 bytes
 * (~6.08MB) — verified directly by constructing that exact payload and
 * measuring `Buffer.byteLength(JSON.stringify(…), "utf8")` (this
 * constant's own boundary test does the same construction). `8,000,000`
 * keeps a real margin above that measured figure while staying a trivial
 * size to parse, so it remains a genuine parse-cost bound rather than a
 * tight fit that could itself start rejecting legitimate verdicts if
 * wording or content shifts slightly.
 *
 * This constant only bounds an ALREADY-PARSED value's re-serialized size
 * (see {@link validateSpecGroundingVerdict}'s own docstring) — reading an
 * untrusted verdict artifact off disk must go through
 * {@link parseAndValidateVerdict} instead, which checks the RAW artifact
 * bytes against this same constant BEFORE ever calling `JSON.parse`.
 */
export const MAX_PAYLOAD_BYTES = 8_000_000;

/**
 * Characters {@link hasDisallowedControlCharacter} treats as legitimate in
 * a multi-line `rationale` — an ordinary newline and an ordinary tab, and
 * nothing else. Every other `\p{Cc}` control character (Codex finding, PR
 * #74 review round 2, FOLD 1 — see {@link MAX_PAYLOAD_BYTES}'s own
 * docstring for the encoding argument this closes) is rejected, including
 * `\r`: a rationale legitimately needs to wrap onto multiple lines, which
 * `\n` alone already provides, so accepting `\r` too would only widen the
 * accepted set without adding anything a real rationale needs.
 */
const ALLOWED_RATIONALE_CONTROL_CHARACTERS = new Set<string>(["\n", "\t"]);

/**
 * Detects a `\p{Cc}` control character in `text` OTHER than the ones
 * {@link ALLOWED_RATIONALE_CONTROL_CHARACTERS} permits.
 *
 * Closes an encoding-cost gap `MAX_PAYLOAD_BYTES`'s per-field-cap
 * derivation didn't account for (Codex finding, PR #74 review round 2,
 * FOLD 1): `JSON.stringify` escapes a raw control character as a 6-byte
 * `\uXXXX` sequence — worse than a CJK character's already-worst-case
 * 3-bytes-per-UTF-16-unit expansion — so a `rationale` field satisfying
 * every OTHER documented cap could still push the true worst-case
 * serialized size well past `MAX_PAYLOAD_BYTES` (`MAX_FINDINGS` ×
 * `MAX_RATIONALE_LENGTH` control characters ≈ 12.1MB) purely through
 * JSON escaping. Rather than chase the ceiling upward again, this
 * excludes the pathological CONTENT at the field level instead: a
 * rationale full of NUL bytes (or similar) is never legitimate agent
 * output for a field a human is meant to read, so rejecting it closes the
 * encoding gap AND keeps garbage out of a human-read field in one move.
 *
 * @param text - The candidate `rationale` value.
 * @returns Whether `text` contains any disallowed control character.
 */
function hasDisallowedControlCharacter(text: string): boolean {
  for (const match of text.matchAll(/\p{Cc}/gu)) {
    if (!ALLOWED_RATIONALE_CONTROL_CHARACTERS.has(match[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Detects an unpaired UTF-16 surrogate code unit in `text` — a lone high
 * surrogate (U+D800–U+DBFF) not immediately followed by a matching low
 * surrogate, or a lone low surrogate (U+DC00–U+DFFF) not immediately
 * preceded by one (Codex finding, PR #74 review round 2, FOLD 1 — the
 * same encoding-cost reasoning as {@link hasDisallowedControlCharacter}:
 * `JSON.stringify` escapes an unpaired surrogate as a 6-byte `\uXXXX`
 * sequence, and an unpaired surrogate is never legitimate agent output —
 * it cannot represent any real character on its own).
 *
 * @param text - The candidate `rationale` value.
 * @returns Whether `text` contains any unpaired surrogate code unit.
 */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++; // Skip the low surrogate this high surrogate correctly pairs with.
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // A low surrogate reached WITHOUT having been skipped by a preceding
      // high-surrogate branch above is, by construction, unpaired.
      return true;
    }
  }
  return false;
}

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
  let validRationale: string | null = null;
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    errors.push(`findings[${index}].rationale must be a non-empty string`);
  } else if (rationale.length > MAX_RATIONALE_LENGTH) {
    errors.push(`findings[${index}].rationale exceeds ${MAX_RATIONALE_LENGTH} characters (${rationale.length})`);
  } else if (hasDisallowedControlCharacter(rationale)) {
    errors.push(
      `findings[${index}].rationale contains a disallowed control character` +
        ` (only ordinary newline "\\n" and tab "\\t" are permitted)`,
    );
  } else if (hasUnpairedSurrogate(rationale)) {
    errors.push(`findings[${index}].rationale contains an unpaired UTF-16 surrogate`);
  } else {
    validRationale = rationale;
  }

  if (validCriterionId === null || typeof satisfied !== "boolean" || validRationale === null) {
    return null;
  }

  return { criterionId: validCriterionId, satisfied, rationale: validRationale };
}

/**
 * Validates a raw (untrusted, possibly prompt-injected) spec-grounding
 * verdict against the JSON contract described above.
 *
 * NOT a resource bound on READING an untrusted artifact (Codex finding,
 * PR #74 review round 2, FOLD 2): this function receives an
 * ALREADY-PARSED JavaScript value. Its own `MAX_PAYLOAD_BYTES` check
 * below re-serializes that value with a fresh `JSON.stringify` to measure
 * it — useful as a defense-in-depth sanity check, but NOT a substitute
 * for bounding the cost of `JSON.parse` itself: an artifact that is
 * gigabytes of insignificant whitespace, or bloated with duplicate JSON
 * keys `JSON.parse` silently collapses to their last value, parses down
 * to a small in-memory value and would PASS this function's own check —
 * even though the memory and CPU `MAX_PAYLOAD_BYTES` exists to bound was
 * already spent producing that value. {@link parseAndValidateVerdict} is
 * THE documented entry point for reading an untrusted verdict artifact
 * (e.g. off disk, in slice 3b-iii): it checks the RAW artifact's own byte
 * length against `MAX_PAYLOAD_BYTES` BEFORE calling `JSON.parse` at all,
 * which is the only place that check can actually prevent the resource
 * cost it exists to bound. Call this function directly only when the
 * caller already holds an in-memory, already-parsed value obtained some
 * other, already-size-bounded way (e.g. a unit test constructing a value
 * directly — never a raw artifact read from an untrusted source).
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

/**
 * Reads a verdict artifact's RAW bytes and validates it — THE documented
 * entry point for reading an untrusted verdict artifact (e.g. off disk,
 * slice 3b-iii's own upcoming responsibility), never `JSON.parse` +
 * {@link validateSpecGroundingVerdict} called directly on the result
 * (Codex finding, PR #74 review round 2, FOLD 2 — see
 * {@link validateSpecGroundingVerdict}'s own docstring for the full
 * reasoning: that function's internal byte check runs AFTER parsing, on
 * an already-parsed value's re-serialization, so it cannot bound the cost
 * `JSON.parse` itself already paid by the time it runs). This function
 * checks the RAW artifact's own byte length against `MAX_PAYLOAD_BYTES`
 * BEFORE calling `JSON.parse` at all, so an over-budget artifact is
 * rejected without ever being parsed.
 *
 * @param raw - The verdict artifact's raw bytes, exactly as read from its
 *   source — a `string` (already UTF-8-decoded text) or a `Buffer` (not
 *   yet decoded; this function measures its byte length directly, so an
 *   over-budget artifact is never even decoded, let alone parsed).
 * @returns The same discriminated result {@link validateSpecGroundingVerdict}
 *   returns — `{ ok: true, verdict }` or `{ ok: false, errors }` — with a
 *   payload-too-large or a malformed-JSON result produced WITHOUT ever
 *   calling `JSON.parse` on an over-budget artifact.
 */
export function parseAndValidateVerdict(raw: string | Buffer): SpecGroundingVerdictValidationResult {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, errors: [`payload too large: ${rawBytes} bytes exceeds ${MAX_PAYLOAD_BYTES}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (err) {
    return {
      ok: false,
      errors: [`payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  return validateSpecGroundingVerdict(parsed);
}
