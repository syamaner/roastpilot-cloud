/**
 * Fails the dependency-review job when the pinned action cannot determine a
 * dependency license.
 *
 * The action's `invalid-license-changes` output is external JSON data. This
 * module bounds and validates it before using any field, and it neutralizes
 * reported values before writing them to the public Actions log.
 */

/** Maximum accepted size of the action output before JSON parsing. */
export const MAX_INVALID_LICENSE_CHANGES_BYTES = 1024 * 1024;

const MAX_REPORTED_DEPENDENCIES = 25;
const MAX_LOG_FIELD_LENGTH = 240;
const UNSAFE_LOG_CODE_POINTS =
  /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

/** Validated fields used to identify one dependency with no known license. */
export interface UnlicensedDependency {
  readonly manifest: string;
  readonly name: string;
  readonly version: string;
  readonly packageUrl: string;
  readonly license: null | "NOASSERTION";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(
      `invalid-license-changes.unlicensed[${index}].${field} must be a string`,
    );
  }
  return value;
}

function neutralizeLogField(value: string): string {
  const neutralized = value
    .replace(UNSAFE_LOG_CODE_POINTS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return neutralized.length <= MAX_LOG_FIELD_LENGTH
    ? neutralized
    : `${neutralized.slice(0, MAX_LOG_FIELD_LENGTH)}...`;
}

/**
 * Parses and validates the pinned dependency-review action's license output.
 *
 * @param rawOutput - `invalid-license-changes` passed through the workflow
 * environment, or `undefined` when the action produced no output.
 * @returns The validated `unlicensed` dependency entries.
 * @throws Error when the output is missing, oversized, malformed, or does not
 * match the fields this check consumes.
 */
export function parseUnlicensedDependencies(
  rawOutput: string | undefined,
): UnlicensedDependency[] {
  if (rawOutput === undefined || rawOutput.trim() === "") {
    throw new Error("invalid-license-changes output is missing or empty");
  }
  if (
    Buffer.byteLength(rawOutput, "utf8") >
    MAX_INVALID_LICENSE_CHANGES_BYTES
  ) {
    throw new Error(
      `invalid-license-changes output exceeds the ${MAX_INVALID_LICENSE_CHANGES_BYTES}-byte limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new Error("invalid-license-changes output is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid-license-changes output must be a JSON object");
  }
  if (!Array.isArray(parsed.unlicensed)) {
    throw new Error(
      "invalid-license-changes.unlicensed must be present as an array",
    );
  }

  return parsed.unlicensed.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(
        `invalid-license-changes.unlicensed[${index}] must be an object`,
      );
    }
    const license = value.license;
    if (license !== null && license !== "NOASSERTION") {
      throw new Error(
        `invalid-license-changes.unlicensed[${index}].license must be null or NOASSERTION`,
      );
    }
    return {
      manifest: requireString(value, "manifest", index),
      name: requireString(value, "name", index),
      version: requireString(value, "version", index),
      packageUrl: requireString(value, "package_url", index),
      license,
    };
  });
}

/**
 * Builds a bounded, workflow-command-safe report for unlicensed dependencies.
 *
 * @param dependencies - Validated dependencies returned by
 * {@link parseUnlicensedDependencies}.
 * @returns A multi-line report whose external fields cannot create log lines.
 */
export function formatUnlicensedDependencyReport(
  dependencies: readonly UnlicensedDependency[],
): string {
  const displayed = dependencies.slice(0, MAX_REPORTED_DEPENDENCIES);
  const lines = displayed.map((dependency, index) => {
    const name = neutralizeLogField(dependency.name) || "(empty name)";
    const version =
      neutralizeLogField(dependency.version) || "(empty version)";
    const manifest =
      neutralizeLogField(dependency.manifest) || "(empty manifest)";
    const packageUrl =
      neutralizeLogField(dependency.packageUrl) || "(empty PURL)";
    return `- ${index + 1}. ${name}@${version} | manifest: ${manifest} | purl: ${packageUrl}`;
  });
  if (dependencies.length > displayed.length) {
    lines.push(
      `- ... ${dependencies.length - displayed.length} additional unlicensed dependencies omitted`,
    );
  }
  return [
    `Dependency review could not determine a license for ${dependencies.length} dependency change(s):`,
    ...lines,
    "Unknown-license exceptions are disabled by factory.md D111.",
  ].join("\n");
}

/**
 * Validates the action output and rejects every unlicensed dependency.
 *
 * @param rawOutput - Raw `invalid-license-changes` workflow output.
 * @throws Error for invalid output or a non-empty `unlicensed` array.
 */
export function assertNoUnlicensedDependencies(
  rawOutput: string | undefined,
): void {
  const dependencies = parseUnlicensedDependencies(rawOutput);
  if (dependencies.length > 0) {
    throw new Error(formatUnlicensedDependencyReport(dependencies));
  }
}

/** Runs the fail-closed unknown-license check from the workflow environment. */
export function main(): void {
  assertNoUnlicensedDependencies(process.env.INVALID_LICENSE_CHANGES);
  console.log("Dependency review reported no undetected licenses.");
}

/** Converts a validation failure into a non-zero workflow process result. */
export function runCli(): void {
  try {
    main();
  } catch (error) {
    console.error(
      "Unknown-license check failed:",
      /* v8 ignore next -- every validation path throws an Error instance. */
      error instanceof Error ? error.message : "unexpected error",
    );
    process.exitCode = 1;
  }
}

/* v8 ignore next -- import-only branch; runCli is unit and process tested. */
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
