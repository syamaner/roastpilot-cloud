import {
  formatCelsius,
  formatPercent,
  formatSeconds,
} from "../lib/format";
import type { Roast } from "@/lib/roast";
import { beanLabel, roastDateLabel } from "../lib/roast-format";
import { RoastThumbnail } from "./RoastThumbnail";

export function RoastHeadline({ roast }: { roast: Roast }) {
  const roastDate = roastDateLabel(roast);

  return (
    <>
      <header className="flex items-center gap-4 rounded-card border border-border bg-surface p-6 shadow-sm">
        <RoastThumbnail />
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold">{beanLabel(roast)}</h1>
          {roast.roast_level === null ? null : (
            <p className="text-sm text-foreground-muted">
              Roast level: {roast.roast_level}
            </p>
          )}
          {roastDate === null ? null : (
            <p className="text-sm text-foreground-muted">
              Roast date: <time dateTime={roastDate}>{roastDate}</time>
            </p>
          )}
        </div>
      </header>
      <dl className="grid grid-cols-2 gap-4 rounded-card border border-border bg-surface p-6 shadow-sm">
        <div>
          <dt className="text-sm text-foreground-muted">Total roast time</dt>
          <dd>{formatSeconds(roast.stats.totalRoastSeconds)}</dd>
        </div>
        <div>
          <dt className="text-sm text-foreground-muted">First crack time</dt>
          <dd>{formatSeconds(roast.stats.firstCrackSeconds)}</dd>
        </div>
        <div>
          <dt className="text-sm text-foreground-muted">First crack temp</dt>
          <dd>{formatCelsius(roast.stats.firstCrackTempC)}</dd>
        </div>
        <div>
          <dt className="text-sm text-foreground-muted">Drop temp</dt>
          <dd>{formatCelsius(roast.stats.dropTempC)}</dd>
        </div>
        <div>
          <dt className="text-sm text-foreground-muted">Development %</dt>
          <dd>{formatPercent(roast.stats.developmentTimePercent)}</dd>
        </div>
      </dl>
    </>
  );
}
