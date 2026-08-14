// probe/p0.mjs
// Characterisation probe P0 for issue #274 (throwaway, do-not-merge).
// Neutral code control: pure functions, no prose, no policy/governance text.
// Deliberately mirrors the ~112-line size of the P1/P2/P3 probes so that the
// only variable across the matrix is content type, not diff size.

/**
 * Clamp a number into an inclusive range.
 */
export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Linear interpolation between a and b at fraction t in [0, 1].
 */
export function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Map a value from one numeric range onto another.
 */
export function remap(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return lerp(outMin, outMax, t);
}

/**
 * Arithmetic mean of a non-empty numeric array; NaN for an empty array.
 */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const total = values.reduce((sum, n) => sum + n, 0);
  return total / values.length;
}

/**
 * Population standard deviation of a numeric array.
 */
export function stdev(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const m = mean(values);
  const variance = mean(values.map((n) => (n - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * Split an array into chunks of at most `size` items.
 */
export function chunk(items, size) {
  if (size <= 0) throw new RangeError('size must be positive');
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Return a new array with consecutive duplicate items removed.
 */
export function dedupeAdjacent(items) {
  const out = [];
  for (const item of items) {
    if (out.length === 0 || out[out.length - 1] !== item) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Convert a duration in seconds into a mm:ss string.
 */
export function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Compute a simple moving average with the given window width.
 */
export function movingAverage(series, window) {
  if (window <= 0) throw new RangeError('window must be positive');
  const out = [];
  for (let i = 0; i < series.length; i += 1) {
    const start = Math.max(0, i - window + 1);
    const slice = series.slice(start, i + 1);
    out.push(mean(slice));
  }
  return out;
}

/**
 * Round a number to a fixed number of decimal places.
 */
export function roundTo(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Sum a numeric array, treating non-finite entries as zero.
 */
export function safeSum(values) {
  return values.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}
