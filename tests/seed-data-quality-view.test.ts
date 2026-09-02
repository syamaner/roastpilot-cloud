import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generate } from "../scripts/seed/generate";
import { parseExportDir } from "../scripts/seed/parse-export";
import type {
  CloudRoastRow,
  TastingReviewRow,
} from "../scripts/seed/types";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const FIXTURE_ROOT = new URL("../snowflake/fixtures/m1-export/", import.meta.url);
const PARSED_EXPORTS = ["session-1", "session-2"].map((session) =>
  parseExportDir(fileURLToPath(new URL(`${session}/`, FIXTURE_ROOT))),
);
const SQL = readFileSync(
  new URL("../snowflake/migrations/R__data_quality_view.sql", import.meta.url),
  "utf8",
);
const SQL_BODY = SQL.slice(SQL.search(/create\s+or\s+replace\s+view/i));

const SLIDER_FIELDS = [
  "aroma",
  "acidity",
  "sweetness",
  "body",
  "aftertaste",
] as const;

interface DataQualityViolation {
  table_name: "cloud_roasts" | "tasting_reviews";
  row_identity: string | null;
  field: string;
  rule: string;
}

type AuditedCloudRoastRow = Omit<CloudRoastRow, "visibility"> & {
  visibility: string | null | undefined;
};

function isOutsideRange(
  value: number | null,
  minimum: number,
  maximum: number,
): boolean {
  return value !== null && (value < minimum || value > maximum);
}

function dataQualityViolations(
  cloudRoasts: readonly AuditedCloudRoastRow[],
  tastingReviews: readonly TastingReviewRow[],
): DataQualityViolation[] {
  const violations: DataQualityViolation[] = [];
  const add = (
    table_name: DataQualityViolation["table_name"],
    row_identity: string | null,
    field: string,
    rule: string,
  ): void => {
    violations.push({ table_name, row_identity, field, rule });
  };

  for (const review of tastingReviews) {
    if (isOutsideRange(review.score, 1, 5)) {
      add("tasting_reviews", review.id, "score", "score out of 1-5");
    }
  }

  for (const roast of cloudRoasts) {
    if (roast.operator_rating !== null &&
        isOutsideRange(roast.operator_rating, 1, 5)) {
      add(
        "cloud_roasts",
        roast.id,
        "operator_rating",
        "operator_rating out of 1-5",
      );
    }
  }

  for (const field of SLIDER_FIELDS) {
    for (const review of tastingReviews) {
      const slider = review[field];
      if (slider !== null && isOutsideRange(slider, 0, 100)) {
        add("tasting_reviews", review.id, field, "slider out of 0-100");
      }
    }
  }

  for (const roast of cloudRoasts) {
    if (roast.visibility !== null && roast.visibility !== undefined &&
        !["private", "unlisted", "public"].includes(roast.visibility)) {
      add(
        "cloud_roasts",
        roast.id,
        "visibility",
        "visibility not in allowed set",
      );
    }
  }

  const idempotencyKeyCounts = new Map<string, number>();
  for (const roast of cloudRoasts) {
    idempotencyKeyCounts.set(
      roast.idempotency_key,
      (idempotencyKeyCounts.get(roast.idempotency_key) ?? 0) + 1,
    );
  }
  for (const [idempotencyKey, count] of idempotencyKeyCounts) {
    if (count > 1) {
      add(
        "cloud_roasts",
        idempotencyKey,
        "idempotency_key",
        "duplicate idempotency_key",
      );
    }
  }

  const publicSlugCounts = new Map<string, number>();
  const publicSlugRowIdentities = new Map<string, string>();
  for (const roast of cloudRoasts) {
    publicSlugCounts.set(
      roast.public_slug,
      (publicSlugCounts.get(roast.public_slug) ?? 0) + 1,
    );
    if (!publicSlugRowIdentities.has(roast.public_slug)) {
      publicSlugRowIdentities.set(
        roast.public_slug,
        roast.id ?? roast.idempotency_key,
      );
    }
  }
  for (const [publicSlug, count] of publicSlugCounts) {
    if (count > 1) {
      add(
        "cloud_roasts",
        publicSlugRowIdentities.get(publicSlug) ?? null,
        "public_slug",
        "duplicate public_slug",
      );
    }
  }

  return violations;
}

function generatedRows(): {
  cloudRoasts: CloudRoastRow[];
  tastingReviews: TastingReviewRow[];
} {
  const output = generate(PARSED_EXPORTS, { now: NOW });
  return {
    cloudRoasts: output.cloudRoasts,
    tastingReviews: output.tastingReviews,
  };
}

function cloneCloudRoast(
  overrides: Partial<AuditedCloudRoastRow>,
): AuditedCloudRoastRow {
  const { cloudRoasts } = generatedRows();
  return { ...cloudRoasts[0], ...overrides };
}

function cloneTastingReview(
  overrides: Partial<TastingReviewRow>,
): TastingReviewRow {
  const { tastingReviews } = generatedRows();
  return { ...tastingReviews[0], ...overrides };
}

function cloudFlags(...rows: AuditedCloudRoastRow[]): DataQualityViolation[] {
  return dataQualityViolations(rows, []);
}

function reviewFlags(...rows: TastingReviewRow[]): DataQualityViolation[] {
  return dataQualityViolations([], rows);
}

describe("data_quality_violations oracle", () => {
  it("T-empty-seed: returns zero rows for the deterministic valid seed", () => {
    const { cloudRoasts, tastingReviews } = generatedRows();

    expect(dataQualityViolations(cloudRoasts, tastingReviews)).toEqual([]);
  });

  it("T-score-neg: flags 6 while accepting the 1 and 5 boundaries", () => {
    expect(reviewFlags(cloneTastingReview({ score: 6 }))).toMatchObject([
      { table_name: "tasting_reviews", field: "score" },
    ]);
    expect(reviewFlags(cloneTastingReview({ score: 1 }))).toEqual([]);
    expect(reviewFlags(cloneTastingReview({ score: 5 }))).toEqual([]);
  });

  it("T-oprating-neg: flags 0 and 6 while accepting 1 and 5", () => {
    for (const operator_rating of [0, 6]) {
      expect(cloudFlags(cloneCloudRoast({ operator_rating }))).toMatchObject([
        { table_name: "cloud_roasts", field: "operator_rating" },
      ]);
    }
    for (const operator_rating of [1, 5]) {
      expect(cloudFlags(cloneCloudRoast({ operator_rating }))).toEqual([]);
    }
  });

  it("T-oprating-null: does not flag a null operator rating", () => {
    expect(cloudFlags(cloneCloudRoast({ operator_rating: null }))).toEqual([]);
  });

  it.each(SLIDER_FIELDS)(
    "T-slider-neg: flags out-of-range %s with the right field and accepts boundaries",
    (field) => {
      for (const slider of [-1, 101]) {
        expect(reviewFlags(cloneTastingReview({ [field]: slider }))).toMatchObject([
          { table_name: "tasting_reviews", field },
        ]);
      }
      for (const slider of [0, 100]) {
        expect(reviewFlags(cloneTastingReview({ [field]: slider }))).toEqual([]);
      }
    },
  );

  it.each(SLIDER_FIELDS)(
    "T-slider-null: does not flag a null %s slider",
    (field) => {
      expect(reviewFlags(cloneTastingReview({ [field]: null }))).toEqual([]);
    },
  );

  it("T-visibility-neg: flags draft and accepts all three allowed values", () => {
    expect(cloudFlags(cloneCloudRoast({ visibility: "draft" }))).toMatchObject([
      { table_name: "cloud_roasts", field: "visibility" },
    ]);
    for (const visibility of ["private", "unlisted", "public"]) {
      expect(cloudFlags(cloneCloudRoast({ visibility }))).toEqual([]);
    }
  });

  it("T-visibility-null: does not flag null visibility", () => {
    expect(cloudFlags(cloneCloudRoast({ visibility: null }))).toEqual([]);
  });

  it("T-dupkey-neg: emits one flag per duplicated key and none when unique", () => {
    const first = cloneCloudRoast({
      id: "roast-1",
      idempotency_key: "duplicate",
      public_slug: "slug-1",
    });
    const second = cloneCloudRoast({
      id: "roast-2",
      idempotency_key: "duplicate",
      public_slug: "slug-2",
    });

    expect(cloudFlags(first, second)).toEqual([{
      table_name: "cloud_roasts",
      row_identity: "duplicate",
      field: "idempotency_key",
      rule: "duplicate idempotency_key",
    }]);
    expect(cloudFlags(
      first,
      { ...second, idempotency_key: "unique" },
    )).toEqual([]);
  });

  it("T-dupkey-multiplicity: emits one flag for each duplicate group", () => {
    const base = cloneCloudRoast({});
    const rows = [
      { ...base, id: "roast-a1", idempotency_key: "dupA", public_slug: "slug-a1" },
      { ...base, id: "roast-a2", idempotency_key: "dupA", public_slug: "slug-a2" },
      { ...base, id: "roast-b1", idempotency_key: "dupB", public_slug: "slug-b1" },
      { ...base, id: "roast-b2", idempotency_key: "dupB", public_slug: "slug-b2" },
      { ...base, id: "roast-b3", idempotency_key: "dupB", public_slug: "slug-b3" },
      {
        ...base,
        id: "roast-unique",
        idempotency_key: "unique",
        public_slug: "slug-unique",
      },
    ];

    expect(cloudFlags(...rows)).toEqual([
      {
        table_name: "cloud_roasts",
        row_identity: "dupA",
        field: "idempotency_key",
        rule: "duplicate idempotency_key",
      },
      {
        table_name: "cloud_roasts",
        row_identity: "dupB",
        field: "idempotency_key",
        rule: "duplicate idempotency_key",
      },
    ]);
  });

  it("T-dupslug-neg: emits one flag per duplicated slug and none when unique", () => {
    const first = cloneCloudRoast({
      id: "roast-1",
      idempotency_key: "key-1",
      public_slug: "duplicate",
    });
    const second = cloneCloudRoast({
      id: "roast-2",
      idempotency_key: "key-2",
      public_slug: "duplicate",
    });

    expect(cloudFlags(first, second)).toEqual([{
      table_name: "cloud_roasts",
      row_identity: "roast-1",
      field: "public_slug",
      rule: "duplicate public_slug",
    }]);
    expect(cloudFlags(
      first,
      { ...second, public_slug: "unique" },
    )).toEqual([]);
  });

  it("T-dupslug-multiplicity: emits one flag for each duplicate group", () => {
    const base = cloneCloudRoast({});
    const rows = [
      { ...base, id: "roast-a1", idempotency_key: "key-a1", public_slug: "dupA" },
      { ...base, id: "roast-a2", idempotency_key: "key-a2", public_slug: "dupA" },
      { ...base, id: "roast-b1", idempotency_key: "key-b1", public_slug: "dupB" },
      { ...base, id: "roast-b2", idempotency_key: "key-b2", public_slug: "dupB" },
      { ...base, id: "roast-b3", idempotency_key: "key-b3", public_slug: "dupB" },
      {
        ...base,
        id: "roast-unique",
        idempotency_key: "key-unique",
        public_slug: "unique",
      },
    ];

    expect(cloudFlags(...rows)).toEqual([
      {
        table_name: "cloud_roasts",
        row_identity: "roast-a1",
        field: "public_slug",
        rule: "duplicate public_slug",
      },
      {
        table_name: "cloud_roasts",
        row_identity: "roast-b1",
        field: "public_slug",
        rule: "duplicate public_slug",
      },
    ]);
  });

  it("T-privacy-shape: exposes only audit metadata and uses the row id", () => {
    const review = cloneTastingReview({
      id: "review-id",
      score: 6,
      reviewer_name: "private name",
      submitted_ip_hash: "private hash",
      notes: "private notes",
    });
    const [violation] = reviewFlags(review);

    expect(Object.keys(violation).sort()).toEqual([
      "field",
      "row_identity",
      "rule",
      "table_name",
    ]);
    expect(violation.row_identity).toBe(review.id);
    expect(Object.values(violation)).not.toContain(review.reviewer_name);
    expect(Object.values(violation)).not.toContain(review.submitted_ip_hash);
    expect(Object.values(violation)).not.toContain(review.notes);
  });
});

describe("data_quality_violations SQL/oracle parity", () => {
  it("contains exactly ten branches joined by nine UNION ALL operators", () => {
    expect(SQL.match(/\bunion\s+all\b/gi)).toHaveLength(9);
  });

  it("binds the score branch labels, source, and predicate", () => {
    expect(SQL).toMatch(
      /select\s+'tasting_reviews'\s+as\s+table_name,\s*id\s+as\s+row_identity,\s*'score'\s+as\s+field,\s*'score out of 1-5'\s+as\s+rule[\s\S]*?from\s+tasting_reviews\s+where\s+score\s*<\s*1\s+or\s+score\s*>\s*5/i,
    );
  });

  it("binds the operator-rating branch labels, source, and predicate", () => {
    expect(SQL).toMatch(
      /select\s+'cloud_roasts'\s+as\s+table_name,\s*id\s+as\s+row_identity,\s*'operator_rating'\s+as\s+field,\s*'operator_rating out of 1-5'\s+as\s+rule[\s\S]*?from\s+cloud_roasts\s+where\s+operator_rating\s+is\s+not\s+null\s+and\s*\(\s*operator_rating\s*<\s*1\s+or\s+operator_rating\s*>\s*5\s*\)/i,
    );
  });

  it.each(SLIDER_FIELDS)(
    "binds the %s branch labels, source, and predicate",
    (field) => {
      expect(SQL).toMatch(new RegExp(
        "select\\s+'tasting_reviews'\\s+as\\s+table_name,\\s*" +
        "id\\s+as\\s+row_identity,\\s*" +
        `'${field}'\\s+as\\s+field,\\s*` +
        "'slider out of 0-100'\\s+as\\s+rule[\\s\\S]*?" +
        "from\\s+tasting_reviews\\s+where\\s+" +
        `${field}\\s+is\\s+not\\s+null\\s+and\\s*\\(\\s*` +
        `${field}\\s*<\\s*0\\s+or\\s+${field}\\s*>\\s*100\\s*\\)`,
        "i",
      ));
    },
  );

  it("binds the visibility branch labels, source, and predicate", () => {
    expect(SQL).toMatch(
      /select\s+'cloud_roasts'\s+as\s+table_name,\s*id\s+as\s+row_identity,\s*'visibility'\s+as\s+field,\s*'visibility not in allowed set'\s+as\s+rule[\s\S]*?from\s+cloud_roasts\s+where\s+visibility\s+not\s+in\s*\(\s*'private'\s*,\s*'unlisted'\s*,\s*'public'\s*\)/i,
    );
  });

  it("binds the duplicate-key branch labels, source, and aggregation", () => {
    expect(SQL).toMatch(
      /select\s+'cloud_roasts'\s+as\s+table_name,\s*idempotency_key\s+as\s+row_identity,\s*'idempotency_key'\s+as\s+field,\s*'duplicate idempotency_key'\s+as\s+rule[\s\S]*?from\s+cloud_roasts\s+group\s+by\s+idempotency_key\s+having\s+count\s*\(\s*\*\s*\)\s*>\s*1/i,
    );
  });

  it("binds the duplicate-slug branch labels, source, and aggregation", () => {
    expect(SQL).toMatch(
      /select\s+'cloud_roasts'\s+as\s+table_name,\s*any_value\s*\(\s*id\s*\)\s+as\s+row_identity,\s*'public_slug'\s+as\s+field,\s*'duplicate public_slug'\s+as\s+rule[\s\S]*?from\s+cloud_roasts\s+group\s+by\s+public_slug\s+having\s+count\s*\(\s*\*\s*\)\s*>\s*1/i,
    );
  });

  it("never references reviewer PII in the SQL body", () => {
    expect(SQL_BODY).not.toMatch(
      /reviewer_name|submitted_ip_hash|notes|\bsummary\b|\braw\b/i,
    );
  });
});
