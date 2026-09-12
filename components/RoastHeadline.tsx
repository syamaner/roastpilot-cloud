import {
  formatCelsius,
  formatPercent,
  formatSeconds,
} from "../lib/format";
import type { Roast } from "@/lib/roast";

export function RoastHeadline({ roast }: { roast: Roast }) {
  const bean = [roast.bean_origin, roast.bean_varietal]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <header>
      <h1>{bean === "" ? "Roast" : bean}</h1>
      {roast.roast_level === null ? null : (
        <p>Roast level: {roast.roast_level}</p>
      )}
      {roast.roasted_at_utc === null ? null : (
        <p>
          Roast date:{" "}
          <time dateTime={roast.roasted_at_utc}>
            {roast.roasted_at_utc.slice(0, 10)}
          </time>
        </p>
      )}
      <dl>
        <div>
          <dt>Total roast time</dt>
          <dd>{formatSeconds(roast.stats.totalRoastSeconds)}</dd>
        </div>
        <div>
          <dt>First crack time</dt>
          <dd>{formatSeconds(roast.stats.firstCrackSeconds)}</dd>
        </div>
        <div>
          <dt>First crack temp</dt>
          <dd>{formatCelsius(roast.stats.firstCrackTempC)}</dd>
        </div>
        <div>
          <dt>Drop temp</dt>
          <dd>{formatCelsius(roast.stats.dropTempC)}</dd>
        </div>
        <div>
          <dt>Development %</dt>
          <dd>{formatPercent(roast.stats.developmentTimePercent)}</dd>
        </div>
      </dl>
    </header>
  );
}
