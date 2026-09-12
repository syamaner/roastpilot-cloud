import { formatCelsius, formatSeconds } from "../lib/format";
import type { CurveSample } from "@/lib/roast";

type SeriesKey = Exclude<keyof CurveSample, "elapsed_s">;
type Point = { x: number; y: number };
type Domain = { min: number; max: number };
type Range = { min: number; max: number };

const PLOT_X: Range = { min: 80, max: 640 };
const PLOT_Y: Range = { min: 320, max: 40 };
const PIXEL_X: Domain = { min: 0, max: 800 };
const PIXEL_Y: Domain = { min: 0, max: 400 };
const VIEW_X: Range = { min: 0, max: 800 };
const VIEW_Y: Range = { min: 0, max: 400 };
const PERCENT_DOMAIN: Domain = { min: 0, max: 100 };

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function finiteMidpoint(first: number, second: number): number {
  const midpoint = first / 2 + second / 2;
  return Number.isFinite(midpoint) ? midpoint : first;
}

function scaleX(value: number, domain: Domain, range: Range): number {
  if (domain.min === domain.max) return finiteMidpoint(range.min, range.max);

  const ratio = (value - domain.min) / (domain.max - domain.min);
  if (!Number.isFinite(ratio)) return finiteMidpoint(range.min, range.max);

  const scaled = range.min + ratio * (range.max - range.min);
  return Number.isFinite(scaled) ? scaled : finiteMidpoint(range.min, range.max);
}

function scaleY(value: number, domain: Domain, range: Range): number {
  if (domain.min === domain.max) return finiteMidpoint(range.min, range.max);

  const ratio = (value - domain.min) / (domain.max - domain.min);
  if (!Number.isFinite(ratio)) return finiteMidpoint(range.min, range.max);

  const scaled = range.min - ratio * (range.min - range.max);
  return Number.isFinite(scaled) ? scaled : finiteMidpoint(range.min, range.max);
}

function roundSvg(value: number): string {
  return value.toFixed(2);
}

function domainOf(values: number[]): Domain {
  if (values.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function collectSegments(curve: CurveSample[], key: SeriesKey): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];

  for (const sample of curve) {
    const value = sample[key];
    if (isFiniteNumber(sample.elapsed_s) && isFiniteNumber(value)) {
      current.push({ x: sample.elapsed_s, y: value });
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function drawableValues(segments: Point[][]): number[] {
  return segments.flatMap((segment) =>
    segment.length < 2 ? [] : segment.map((point) => point.y),
  );
}

function pathFor(
  segments: Point[][],
  xDomain: Domain,
  yDomain: Domain,
  interpolation: "linear" | "step-after",
): string {
  const commands: string[] = [];

  for (const segment of segments) {
    if (segment.length < 2) continue;

    const first = segment[0];
    commands.push(
      `M ${roundSvg(scaleX(first.x, xDomain, PLOT_X))} ${roundSvg(scaleY(first.y, yDomain, PLOT_Y))}`,
    );

    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1];
      const point = segment[index];
      const x = roundSvg(scaleX(point.x, xDomain, PLOT_X));
      const y = roundSvg(scaleY(point.y, yDomain, PLOT_Y));

      if (interpolation === "step-after") {
        const previousY = roundSvg(scaleY(previous.y, yDomain, PLOT_Y));
        commands.push(`L ${x} ${previousY} L ${x} ${y}`);
      } else {
        commands.push(`L ${x} ${y}`);
      }
    }
  }

  return commands.join(" ");
}

function rateLabel(value: number): string {
  return `${formatCelsius(value)}/min`;
}

export default function RoastCurve({
  curve,
}: {
  curve: CurveSample[] | null;
}) {
  const elapsed =
    curve?.flatMap((sample) =>
      isFiniteNumber(sample.elapsed_s) ? [sample.elapsed_s] : [],
    ) ?? [];

  if (curve === null || curve.length === 0 || elapsed.length === 0) {
    return (
      <section aria-label="Roast curve">
        <p>Curve not shared</p>
      </section>
    );
  }

  const xDomain = domainOf(elapsed);
  const beanSegments = collectSegments(curve, "bean_temp_c");
  const envSegments = collectSegments(curve, "env_temp_c");
  const rateSegments = collectSegments(curve, "ror_c_per_min");
  const heatSegments = collectSegments(curve, "heat_percent");
  const fanSegments = collectSegments(curve, "fan_percent");
  const temperatureValues = drawableValues(beanSegments).concat(
    drawableValues(envSegments),
  );
  const rateValues = drawableValues(rateSegments);
  const temperatureDomain = domainOf(temperatureValues);
  const rateDomain = domainOf(rateValues);

  const beanPath = pathFor(
    beanSegments,
    xDomain,
    temperatureDomain,
    "linear",
  );
  const envPath = pathFor(
    envSegments,
    xDomain,
    temperatureDomain,
    "linear",
  );
  const ratePath = pathFor(
    rateSegments,
    xDomain,
    rateDomain,
    "linear",
  );
  const heatPath = pathFor(
    heatSegments,
    xDomain,
    PERCENT_DOMAIN,
    "step-after",
  );
  const fanPath = pathFor(
    fanSegments,
    xDomain,
    PERCENT_DOMAIN,
    "step-after",
  );
  const xTicks = [
    xDomain.min,
    finiteMidpoint(xDomain.min, xDomain.max),
    xDomain.max,
  ];

  return (
    <section aria-label="Roast curve">
      <div data-testid="roast-curve-scroll" style={{ overflowX: "auto" }}>
        <svg
          role="img"
          aria-label="Roast curve: temperature in Celsius, rate in Celsius per minute, percent, and elapsed seconds"
          viewBox="0 0 800 400"
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{
            display: "block",
            height: "auto",
            maxWidth: 800,
            minWidth: 640,
          }}
        >
        <title>Roast curve by elapsed seconds with three Celsius-based scales</title>
        <path
          d={`M ${roundSvg(scaleX(PLOT_X.min, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))} L ${roundSvg(scaleX(PLOT_X.max, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))}`}
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path
          d={`M ${roundSvg(scaleX(PLOT_X.min, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))} L ${roundSvg(scaleX(PLOT_X.min, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}`}
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path
          d={`M ${roundSvg(scaleX(PLOT_X.max, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))} L ${roundSvg(scaleX(PLOT_X.max, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}`}
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path
          d={`M ${roundSvg(scaleX(720, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))} L ${roundSvg(scaleX(720, PIXEL_X, VIEW_X))} ${roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}`}
          stroke="currentColor"
          strokeWidth="2.5"
        />
        {beanPath === "" ? null : (
          <path
            data-testid="series-bean"
            d={beanPath}
            fill="none"
            stroke="sienna"
            strokeWidth="2.5"
          />
        )}
        {envPath === "" ? null : (
          <path
            data-testid="series-env"
            d={envPath}
            fill="none"
            stroke="steelblue"
            strokeWidth="2.5"
          />
        )}
        {ratePath === "" ? null : (
          <path
            data-testid="series-ror"
            d={ratePath}
            fill="none"
            stroke="mediumpurple"
            strokeWidth="2.5"
          />
        )}
        {heatPath === "" ? null : (
          <path
            data-testid="series-heat"
            d={heatPath}
            fill="none"
            stroke="#c2410c"
            strokeWidth="2.5"
          />
        )}
        {fanPath === "" ? null : (
          <path
            data-testid="series-fan"
            d={fanPath}
            fill="none"
            stroke="teal"
            strokeWidth="2.5"
          />
        )}
        {xTicks.map((tick, index) => (
          <text
            key={`${roundSvg(tick)}-${index}`}
            x={roundSvg(scaleX(tick, xDomain, PLOT_X))}
            y={roundSvg(scaleY(345, PIXEL_Y, VIEW_Y))}
            textAnchor="middle"
            fill="currentColor"
            fontSize="16"
          >
            {formatSeconds(tick)}
          </text>
        ))}
        <text
          x={roundSvg(scaleX(360, PIXEL_X, VIEW_X))}
          y={roundSvg(scaleY(380, PIXEL_Y, VIEW_Y))}
          textAnchor="middle"
          fill="currentColor"
          fontSize="16"
        >
          Elapsed time (seconds)
        </text>
        {temperatureValues.length === 0 ? null : (
          <>
            <text
              x={roundSvg(scaleX(15, PIXEL_X, VIEW_X))}
              y={roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}
              fill="currentColor"
              fontSize="16"
            >
              Temperature (°C): {formatCelsius(temperatureDomain.max)}
            </text>
            <text
              x={roundSvg(scaleX(15, PIXEL_X, VIEW_X))}
              y={roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))}
              fill="currentColor"
              fontSize="16"
            >
              {formatCelsius(temperatureDomain.min)}
            </text>
          </>
        )}
        {rateValues.length === 0 ? null : (
          <>
            <text
              x={roundSvg(scaleX(635, PIXEL_X, VIEW_X))}
              y={roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}
              textAnchor="end"
              fill="currentColor"
              fontSize="16"
            >
              RoR (°C/min): {rateLabel(rateDomain.max)}
            </text>
            <text
              x={roundSvg(scaleX(635, PIXEL_X, VIEW_X))}
              y={roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))}
              textAnchor="end"
              fill="currentColor"
              fontSize="16"
            >
              {rateLabel(rateDomain.min)}
            </text>
          </>
        )}
        <text
          x={roundSvg(scaleX(795, PIXEL_X, VIEW_X))}
          y={roundSvg(scaleY(PLOT_Y.max, PIXEL_Y, VIEW_Y))}
          textAnchor="end"
          fill="currentColor"
          fontSize="16"
        >
          Percent: 100%
        </text>
        <text
          x={roundSvg(scaleX(795, PIXEL_X, VIEW_X))}
          y={roundSvg(scaleY(PLOT_Y.min, PIXEL_Y, VIEW_Y))}
          textAnchor="end"
          fill="currentColor"
          fontSize="16"
        >
          0%
        </text>
        </svg>
      </div>
      <ul aria-label="Roast curve legend">
        <li>
          <span
            aria-hidden="true"
            data-testid="legend-swatch-bean"
            style={{
              backgroundColor: "sienna",
              display: "inline-block",
              height: "0.75rem",
              marginRight: "0.375rem",
              width: "0.75rem",
            }}
          />
          Bean temp
        </li>
        <li>
          <span
            aria-hidden="true"
            data-testid="legend-swatch-env"
            style={{
              backgroundColor: "steelblue",
              display: "inline-block",
              height: "0.75rem",
              marginRight: "0.375rem",
              width: "0.75rem",
            }}
          />
          Env temp
        </li>
        <li>
          <span
            aria-hidden="true"
            data-testid="legend-swatch-ror"
            style={{
              backgroundColor: "mediumpurple",
              display: "inline-block",
              height: "0.75rem",
              marginRight: "0.375rem",
              width: "0.75rem",
            }}
          />
          RoR
        </li>
        <li>
          <span
            aria-hidden="true"
            data-testid="legend-swatch-heat"
            style={{
              backgroundColor: "#c2410c",
              display: "inline-block",
              height: "0.75rem",
              marginRight: "0.375rem",
              width: "0.75rem",
            }}
          />
          Heat
        </li>
        <li>
          <span
            aria-hidden="true"
            data-testid="legend-swatch-fan"
            style={{
              backgroundColor: "teal",
              display: "inline-block",
              height: "0.75rem",
              marginRight: "0.375rem",
              width: "0.75rem",
            }}
          />
          Fan
        </li>
      </ul>
    </section>
  );
}
