export function RoastThumbnail() {
  return (
    <div
      aria-hidden="true"
      data-testid="roast-thumbnail"
      className="h-20 w-24 shrink-0 overflow-hidden rounded-control bg-surface-muted"
      style={{
        backgroundImage:
          "linear-gradient(135deg, var(--rp-surface-muted), var(--rp-surface-subtle))",
      }}
    >
      <svg viewBox="0 0 96 80" width="96" height="80">
        <path
          d="M 0 64 C 18 62, 24 44, 42 46 S 66 18, 96 16"
          fill="none"
          style={{ stroke: "var(--rp-primary)" }}
          strokeWidth="6"
        />
        <path
          d="M 0 70 C 24 68, 38 58, 52 54 S 78 40, 96 28"
          fill="none"
          style={{ stroke: "var(--rp-series-bean)" }}
          strokeWidth="3"
        />
      </svg>
    </div>
  );
}
