export function formatSeconds(s: number): string {
  const roundedSeconds = Math.round(s);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatCelsius(n: number | null): string {
  if (n === null) return "—";
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} °C`;
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)} %`;
}

export function formatReviewerName(name: string | null): string {
  const t = (name ?? "").trim();
  if (t === "") return "Anonymous";
  return t.split(/\s+/)[0];
}
