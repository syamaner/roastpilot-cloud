/** A successful validated value or every validation error found. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly string[] };

/** True for non-null, non-array objects. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns every enumerable own key outside a contract's closed key set. */
export function unexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

/** True only for a positive integer that JSON numbers represent exactly. */
export function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** True only for a non-negative integer that JSON numbers represent exactly. */
export function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Finds a case-insensitive token bounded by non-alphanumeric delimiters. */
export function containsDelimiterBoundedToken(
  text: string,
  token: string,
): boolean {
  const lowercaseText = text.toLowerCase();
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`).test(
    lowercaseText,
  );
}

/** True only for a lowercase, byte-exact 40-character hexadecimal SHA. */
export function isSha40Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** True only for a whole-second UTC instant with a literal trailing Z. */
export function isIsoUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/** True for a non-empty string no longer than the caller's character bound. */
export function isBoundedNonEmptyString(
  value: unknown,
  maxCharacters: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxCharacters
  );
}

/** True when a string's UTF-8 representation is within the caller's bound. */
export function isUtf8PayloadWithinLimit(
  value: string,
  maxBytes: number,
): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes;
}
