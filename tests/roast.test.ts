import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeStatement,
  SqlApiError,
  type SqlApiResult,
} from "../lib/sqlapi";
import {
  dropTempC,
  firstCrackTempC,
  getReviewsByRoast,
  getRoastBySlug,
  REVIEWS_LIMIT,
  RoastSchemaError,
  type CurveSample,
  type RoastSummary,
} from "../lib/roast";

vi.mock("../lib/sqlapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sqlapi")>();
  return { ...actual, executeStatement: vi.fn() };
});

const ROAST_COLUMNS = [
  "PUBLIC_SLUG",
  "BEAN_ORIGIN",
  "BEAN_VARIETAL",
  "BEAN_WEIGHT_G",
  "PROFILE_NAME",
  "ROAST_LEVEL",
  "ROASTED_AT_UTC",
  "CREATED_AT",
  "SUMMARY",
  "CURVE",
];
const REVIEW_COLUMNS = [
  "PUBLIC_SLUG",
  "REVIEWER_NAME",
  "SCORE",
  "AROMA",
  "ACIDITY",
  "SWEETNESS",
  "BODY",
  "AFTERTASTE",
  "BREW_METHOD",
  "NOTES",
  "CREATED_AT",
];

type FixtureSummary = RoastSummary & Record<string, unknown>;
const executeMock = vi.mocked(executeStatement);

function loadSummary(session: 1 | 2): FixtureSummary {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        `snowflake/fixtures/m1-export/session-${session}/summary.json`,
      ),
      "utf8",
    ),
  ) as FixtureSummary;
}

function sample(elapsed: number | null, temperature: number | null): CurveSample {
  return {
    elapsed_s: elapsed,
    bean_temp_c: temperature,
    env_temp_c: 210,
    heat_percent: 40,
    fan_percent: 30,
    ror_c_per_min: 8,
  };
}

function apiResult(
  names: string[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
  rowCount = rows.length,
): SqlApiResult {
  return {
    columns: names.map((name) => ({ name, type: "TEXT" })),
    rows,
    rowCount,
  };
}

function roastRow(
  summary: unknown = loadSummary(1),
  curve: unknown = [sample(1180.402, 201.5)],
): ReadonlyArray<string | null> {
  return [
    "ethiopia-natural",
    "Ethiopia Guji",
    "74110",
    "250",
    "Filter 01",
    "light",
    "2026-06-07T12:19:47.297516+00:00",
    "2026-06-07T12:25:50.249395+00:00",
    JSON.stringify(summary),
    curve === null ? null : JSON.stringify(curve),
  ];
}

function reviewRows(): ReadonlyArray<ReadonlyArray<string | null>> {
  return [
    [
      "ethiopia-natural",
      "Ari",
      "5",
      "5",
      "4",
      "5",
      "4",
      "5",
      "V60",
      "Peach and jasmine",
      "2026-06-09T10:00:00+00:00",
    ],
    [
      "ethiopia-natural",
      null,
      "4",
      null,
      "4",
      "4",
      "3",
      null,
      null,
      null,
      "2026-06-08T10:00:00+00:00",
    ],
  ];
}

beforeEach(() => {
  executeMock.mockReset();
});

describe("typed roast reads", () => {
  it("1. maps the session-1 fixture into a typed roast and charge-relative stats", async () => {
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [roastRow()]));

    const roast = await getRoastBySlug("ethiopia-natural");

    expect(roast).not.toBeNull();
    expect(roast?.bean_weight_g).toBe(250);
    expect(roast?.summary.started_at_utc).toBe(loadSummary(1).started_at_utc);
    expect(roast?.stats).toMatchObject({
      totalRoastSeconds: 637.106,
      developmentTimePercent: 15.003,
      dropTempC: 201.5,
    });
    expect(roast?.stats.firstCrackSeconds).toBeCloseTo(541.519, 3);
  });

  it("2. derives FC temperature on the session-start clock, ignoring charge-clock decoys", async () => {
    const curve = [
      sample(541.519, 150),
      sample(1180.402, 202.25),
      sample(1190, 205),
    ];
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow(loadSummary(1), curve)]),
    );

    const roast = await getRoastBySlug("ethiopia-natural");

    expect(roast?.stats.firstCrackTempC).toBe(202.25);
  });

  it("3. breaks equal-distance curve ties toward the earlier sample", () => {
    const summary = loadSummary(1);
    const elapsed =
      (Date.parse(summary.first_crack_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;

    expect(
      firstCrackTempC(
        [sample(elapsed + 2, 204), sample(elapsed - 2, 200)],
        summary,
      ),
    ).toBe(200);
  });

  it("4. maps two complete review rows with nullable cells", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, reviewRows()));

    const reviews = await getReviewsByRoast("ethiopia-natural");

    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ reviewer_name: "Ari", score: 5 });
    expect(reviews[1]).toMatchObject({ reviewer_name: null, aroma: null });
  });

  it("5. orders the reviews query by newest creation time", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, []));

    await getReviewsByRoast("ethiopia-natural");

    expect(executeMock.mock.calls[0][0]).toMatch(
      /order by created_at desc,/i,
    );
  });

  it("T-bound-applied: limits the reviews query to 50 rows", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, []));

    await getReviewsByRoast("ethiopia-natural");

    expect(executeMock.mock.calls[0][0]).toMatch(/limit\s+50/i);
  });

  it("T-order-then-bound: applies the cap after newest-first ordering", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, []));

    await getReviewsByRoast("ethiopia-natural");

    expect(executeMock.mock.calls[0][0]).toMatch(
      /order by created_at desc,[^;]*\blimit\s+50/i,
    );
  });

  it("T-tiebreak-deterministic: orders ties by every projected value", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, []));

    await getReviewsByRoast("ethiopia-natural");

    expect(executeMock.mock.calls[0][0]).toMatch(
      /order by created_at desc,\s*reviewer_name,\s*score,\s*aroma,\s*acidity,\s*sweetness,\s*body,\s*aftertaste,\s*brew_method,\s*notes\s+limit/i,
    );
  });

  it("T-const-pin: pins the reviews limit", () => {
    expect(REVIEWS_LIMIT).toBe(50);
  });

  it("T-not-oldest: maps every mocked review in transport order", async () => {
    const rows = Array.from({ length: REVIEWS_LIMIT + 1 }, (_, index) => {
      const row = [...reviewRows()[0]];
      row[1] = `Reviewer ${index}`;
      return row;
    });
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, rows));

    const reviews = await getReviewsByRoast("ethiopia-natural");

    expect(reviews).toHaveLength(rows.length);
    expect(reviews.map((review) => review.reviewer_name)).toEqual(
      rows.map((row) => row[1]),
    );
  });

  it("6. accepts session-2's null lifecycle extras and uses top-level roast stats", async () => {
    const summary = loadSummary(2);
    expect(summary.stopped_at_utc).toBeNull();
    expect(summary.cooling_stopped_at_utc).toBeNull();
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow(summary, [])]),
    );

    const roast = await getRoastBySlug("ethiopia-natural");

    expect(roast?.stats.totalRoastSeconds).toBe(639.346);
    expect(roast?.stats.developmentTimePercent).toBe(16.231);
  });

  it("7. keeps headline and curve lookup timing origins distinct", async () => {
    const summary = loadSummary(1);
    const curveElapsed =
      (Date.parse(summary.first_crack_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [
        roastRow(summary, [sample(541.519, 150), sample(curveElapsed, 201)]),
      ]),
    );

    const roast = await getRoastBySlug("ethiopia-natural");

    expect(curveElapsed).toBeCloseTo(1180.402, 3);
    expect(roast?.stats.firstCrackSeconds).toBeCloseTo(541.519, 3);
    expect(roast?.stats.firstCrackTempC).toBe(201);
  });

  it("8. treats a null curve and null FC temperature as first-class values", async () => {
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow(loadSummary(1), null)]),
    );

    await expect(getRoastBySlug("ethiopia-natural")).resolves.toMatchObject({
      curve: null,
      stats: { firstCrackTempC: null, dropTempC: null },
    });
  });

  it("9. maps an empty roast result set to null", async () => {
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, []));
    await expect(getRoastBySlug("missing")).resolves.toBeNull();
  });

  it("10. fails closed when a slug unexpectedly returns multiple roasts", async () => {
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow(), roastRow()]),
    );
    await expect(getRoastBySlug("duplicate")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("11. maps an empty reviews result set to an empty list", async () => {
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, []));
    await expect(getReviewsByRoast("no-reviews")).resolves.toEqual([]);
  });

  it("12. rejects an extra roast projection column", async () => {
    executeMock.mockResolvedValue(
      apiResult([...ROAST_COLUMNS, "VISIBILITY"], [[...roastRow(), "public"]]),
    );
    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("13. rejects an extra review projection column", async () => {
    executeMock.mockResolvedValue(
      apiResult(
        [...REVIEW_COLUMNS, "HASHED_IP"],
        reviewRows().map((row) => [...row, "digest"]),
      ),
    );
    await expect(
      getReviewsByRoast("ethiopia-natural"),
    ).rejects.toBeInstanceOf(RoastSchemaError);
  });

  it("14. rejects a summary missing first_crack_at_utc", async () => {
    const summary: Record<string, unknown> = { ...loadSummary(1) };
    delete summary.first_crack_at_utc;
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [roastRow(summary)]));
    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("15. rejects a retyped total_roast_seconds", async () => {
    const summary = { ...loadSummary(1), total_roast_seconds: "637.106" };
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [roastRow(summary)]));
    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("16. wraps malformed summary JSON in the generic typed error", async () => {
    const row = [...roastRow()];
    row[8] = "{secret-invalid";
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [row]));

    const promise = getRoastBySlug("sensitive-slug");
    await expect(promise).rejects.toBeInstanceOf(RoastSchemaError);
    await expect(promise).rejects.not.toBeInstanceOf(SyntaxError);
    await expect(promise).rejects.not.toThrow(/secret|sensitive/i);
  });

  it("17. wraps malformed curve JSON in the typed error", async () => {
    const row = [...roastRow()];
    row[9] = "[invalid";
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [row]));
    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("18. rejects a seventh curve key", async () => {
    const curve = [{ ...sample(1180.402, 201), bean_temp_f: 393.8 }];
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow(loadSummary(1), curve)]),
    );
    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("19. propagates a transport not_found error instead of converting it to null", async () => {
    const error = new SqlApiError("not_found", "bounded");
    executeMock.mockRejectedValue(error);
    await expect(getRoastBySlug("missing-view")).rejects.toBe(error);
  });

  it("20. sends an adversarial slug only through positional bindings", async () => {
    const slug = "slug'; DROP--";
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, []));

    await getRoastBySlug(slug);

    const [statement, bindings] = executeMock.mock.calls[0];
    expect(statement).toContain(":1");
    expect(statement).not.toContain(slug);
    expect(bindings?.["1"]).toEqual({ type: "TEXT", value: slug });
  });

  it("21. uses only the exact view projections without wildcard or private fields", async () => {
    executeMock
      .mockResolvedValueOnce(apiResult(ROAST_COLUMNS, []))
      .mockResolvedValueOnce(apiResult(REVIEW_COLUMNS, []));
    await getRoastBySlug("ethiopia-natural");
    await getReviewsByRoast("ethiopia-natural");

    const roastStatement = executeMock.mock.calls[0][0];
    const reviewStatement = executeMock.mock.calls[1][0];
    const selected = (statement: string) =>
      statement.slice(0, statement.toLowerCase().indexOf(" from "))
        .replace(/^select /i, "")
        .split(",");
    expect(selected(roastStatement)).toHaveLength(10);
    expect(selected(reviewStatement)).toHaveLength(11);
    expect(roastStatement).not.toMatch(/visibility|owner|hashed|\braw\b|\bip\b/i);
    expect(reviewStatement).not.toMatch(/hashed|\bip\b/i);
    expect(`${roastStatement}${reviewStatement}`).not.toContain("*");
  });

  it("22. contains only the project's required temperature unit", () => {
    const source = readFileSync(join(process.cwd(), "lib/roast.ts"), "utf8");
    expect(source).not.toMatch(/fahrenheit|_f\b|\*9\/5/i);
  });

  it("23. consumes the SQL API transport without reimplementing it", () => {
    const source = readFileSync(join(process.cwd(), "lib/roast.ts"), "utf8");
    expect(source).toMatch(/from ["']\.\/sqlapi["']/);
    expect(source).toMatch(/executeStatement/);
    expect(source).not.toMatch(
      /node:crypto|snowflakecomputing|api\/v2\/statements|fetch\(/,
    );
  });

  it("24. rejects a null summary cell", async () => {
    const row = [...roastRow()];
    row[8] = null;
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [row]));

    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("25. returns null when the nearest FC row has a null temperature", () => {
    const summary = loadSummary(1);
    const elapsed =
      (Date.parse(summary.first_crack_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;
    const curve = [
      sample(elapsed, null),
      sample(null, 199),
      sample(Number.NaN, 200),
      sample(elapsed + 1, 203),
    ];

    // R__proc_recompute_summary.sql ranks by elapsed time before reading temp.
    expect(firstCrackTempC(curve, summary)).toBeNull();
  });

  it("26. returns null when a curve is empty or has no valid sample", () => {
    const summary = loadSummary(1);
    expect(firstCrackTempC([], summary)).toBeNull();
    expect(dropTempC([], summary)).toBeNull();
    expect(
      firstCrackTempC(
        [sample(null, 202), sample(Number.NaN, null)],
        summary,
      ),
    ).toBeNull();
  });

  it("27. rejects a roast row whose cell count does not match its columns", async () => {
    executeMock.mockResolvedValue(
      apiResult(ROAST_COLUMNS, [roastRow().slice(0, 9)]),
    );

    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("28. rejects a review row whose cell count does not match its columns", async () => {
    executeMock.mockResolvedValue(
      apiResult(REVIEW_COLUMNS, [reviewRows()[0].slice(0, 10)]),
    );

    await expect(
      getReviewsByRoast("ethiopia-natural"),
    ).rejects.toBeInstanceOf(RoastSchemaError);
  });

  it("29. rejects a roast scalar that cannot be coerced to its schema type", async () => {
    const row = [...roastRow()];
    row[3] = "not-a-number";
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [row]));

    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("30. rejects a review scalar that cannot be coerced to its schema type", async () => {
    const row = [...reviewRows()[0]];
    row[2] = "";
    executeMock.mockResolvedValue(apiResult(REVIEW_COLUMNS, [row]));

    await expect(
      getReviewsByRoast("ethiopia-natural"),
    ).rejects.toBeInstanceOf(RoastSchemaError);
  });

  it("31. rejects inconsistent transport row-count metadata", async () => {
    executeMock.mockResolvedValue(apiResult(ROAST_COLUMNS, [], 1));

    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("32. resolves millisecond-resolution float ties to the earlier sample regardless of order", () => {
    const summary = loadSummary(1);
    const earlier = sample(1180.399, 200);
    const later = sample(1180.405, 210);

    expect(firstCrackTempC([earlier, later], summary)).toBe(200);
    expect(firstCrackTempC([later, earlier], summary)).toBe(200);
  });

  it("33. preserves raw-distance ordering below microsecond precision", () => {
    const summary = {
      ...loadSummary(1),
      started_at_utc: "2026-01-01T00:00:00Z",
      first_crack_at_utc: "2026-01-01T00:00:10Z",
    };
    const earlierButFarther = sample(9.9999994, 200);
    const laterButCloser = sample(10.00000051, 210);

    expect(
      firstCrackTempC([earlierButFarther, laterButCloser], summary),
    ).toBe(210);
    expect(
      firstCrackTempC([laterButCloser, earlierButFarther], summary),
    ).toBe(210);
  });

  it("34. rejects a same-count roast projection with a disallowed column name", async () => {
    const columns = [...ROAST_COLUMNS];
    columns[9] = "VISIBILITY";
    executeMock.mockResolvedValue(apiResult(columns, [roastRow()]));

    await expect(getRoastBySlug("ethiopia-natural")).rejects.toBeInstanceOf(
      RoastSchemaError,
    );
  });

  it("35. rejects a same-count review projection with a disallowed column name", async () => {
    const columns = [...REVIEW_COLUMNS];
    columns[10] = "HASHED_IP";
    executeMock.mockResolvedValue(apiResult(columns, [reviewRows()[0]]));

    await expect(
      getReviewsByRoast("ethiopia-natural"),
    ).rejects.toBeInstanceOf(RoastSchemaError);
  });

  it("36. derives drop temperature from the nearest session-start-relative sample", () => {
    const summary = loadSummary(1);
    const elapsed =
      (Date.parse(summary.beans_dropped_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;

    expect(
      dropTempC(
        [sample(elapsed - 10, 190), sample(elapsed + 0.2, 206)],
        summary,
      ),
    ).toBe(206);
  });

  it("37. returns null drop temperature for a null curve", () => {
    expect(dropTempC(null, loadSummary(1))).toBeNull();
  });

  it("38. returns null when the nearest drop row has a null temperature", () => {
    const summary = loadSummary(1);
    const elapsed =
      (Date.parse(summary.beans_dropped_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;

    expect(
      dropTempC(
        [sample(elapsed, null), sample(elapsed + 0.5, 208)],
        summary,
      ),
    ).toBeNull();
  });

  it("39. preserves a legitimate zero-degree nearest temperature", () => {
    const summary = loadSummary(1);
    const elapsed =
      (Date.parse(summary.first_crack_at_utc) -
        Date.parse(summary.started_at_utc)) /
      1_000;

    expect(
      firstCrackTempC(
        [sample(elapsed, 0), sample(elapsed + 0.5, 208)],
        summary,
      ),
    ).toBe(0);
  });
});
