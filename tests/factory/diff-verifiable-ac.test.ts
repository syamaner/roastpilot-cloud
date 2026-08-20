import { describe, expect, it } from "vitest";
import * as sharedPatterns from "../../scripts/factory/acceptance-criteria-lines.mts";
import * as diffVerifiableAcModule from "../../scripts/factory/diff-verifiable-ac.mts";
import { enforceDiffVerifiableAc } from "../../scripts/factory/diff-verifiable-ac.mts";
import * as specGroundingModule from "../../scripts/factory/spec-grounding-logic.mts";
import type { ReadinessLabel } from "../../scripts/factory/triage-verdict-schema.mts";

function issueBody(criterion: string, prefix = "", suffix = ""): string {
  return [
    prefix,
    "### Acceptance criteria",
    `- [ ] ${criterion}`,
    "### In-scope surface",
    "- scripts/factory",
    suffix,
  ].join("\n");
}

function expectDowngrade(
  criterion: string,
  patternId: string,
  readiness: ReadinessLabel = "ready-to-implement",
): void {
  const result = enforceDiffVerifiableAc(readiness, issueBody(criterion));
  expect(result).toMatchObject({
    effectiveReadiness: "ready-to-spec",
    downgraded: true,
    patternId,
  });
  expect(result.downgradeNotice).toContain(`matched: \`${patternId}\``);
}

describe("enforceDiffVerifiableAc — delegation grammar", () => {
  it("B1/G1/G8: downgrades an AC that matches a section", () => {
    expectDowngrade("the schema matches §4", "matches-section");
  });

  it("B2/G8: catches the C2-S1 noun-in-section delegation shape", () => {
    expectDowngrade(
      "the five tables and the columns in plan §4 exist",
      "noun-in-section",
    );
  });

  it("B3/G8: downgrades an AC delegated per plan.md", () => {
    expectDowngrade("create the schema per plan.md", "per-plan");
  });

  it("B4/G8: downgrades an AC delegated as described in a section", () => {
    expectDowngrade("the behavior is as described in §4", "as-in-section");
  });

  it("B5/G8: downgrades a non-parenthetical see-section delegation", () => {
    expectDowngrade("create the required tables; see §4", "see-section");
  });

  it("B6/G8: downgrades an unquoted compare-to-file delegation", () => {
    expectDowngrade(
      "compare the output to file snowflake/plan.md",
      "compare-to-file",
    );
  });

  it("B7/G6: applies to conventional implementation readiness too", () => {
    expectDowngrade(
      "the schema matches §4",
      "matches-section",
      "ready-for-conventional-implementation",
    );
  });

  it("intentionally treats section references to non-plan documents as external delegation", () => {
    expectDowngrade(
      "output matches section 4 of RFC 7231",
      "matches-section",
    );
  });

  it("downgrades an unclosed-parenthesis criterion whose delegation remains operative", () => {
    expectDowngrade("schema matches §4 (pending detail", "matches-section");
  });

  it("downgrades a wholly-parenthesized matches-section delegation", () => {
    expectDowngrade("(schema matches §4)", "matches-section");
  });

  it("downgrades a wholly-parenthesized see-section delegation", () => {
    expectDowngrade("(see §4)", "see-section");
  });

  it.each([
    "the secure views in plan §3 exist",
    "the procedures in §6 exist",
    "the grants in section 6 are applied",
  ])(
    "recognizes schema-domain resource delegation: %s",
    (criterion) => {
      expectDowngrade(criterion, "noun-in-section");
    },
  );

  it.each([
    ["schema matches &sect;4", "matches-section"],
    ["schema matches &#167;4", "matches-section"],
    ["schema matches &#xa7;4", "matches-section"],
    ["create the schema per plan&#46;md", "per-plan"],
  ])(
    "decodes rendered character entities before matching: %s",
    (criterion, patternId) => {
      expectDowngrade(criterion, patternId);
    },
  );

  it("allows an enumerated criterion containing an innocuous named entity", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("returns roast &amp; review counts"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("safely replaces a numeric entity outside the Unicode range", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("returns &#999999999999999999999999; counts"),
    );
    expect(result.downgraded).toBe(false);
  });
});

describe("enforceDiffVerifiableAc — real corpus heading forms", () => {
  it("downgrades delegation under a whole-line bold AC label", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      "**Acceptance criteria**\n- [ ] the columns in plan §4 exist",
    );
    expect(result.patternId).toBe("noun-in-section");
  });

  it("allows enumeration under a colon-suffixed bold AC label", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "**Acceptance criteria:**",
        "- [ ] cloud_roasts has id, slug, and temperature_celsius columns",
        "**In-scope surface**",
        "scripts/factory",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("stops a bold-label AC section at the next whole-line bold field label", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "**Acceptance criteria**",
        "- [ ] cloud_roasts has id and slug columns",
        "**In-scope surface:**",
        "- [ ] the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("stops a bold-label AC section at the next ATX heading", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "**Acceptance criteria**",
        "- [ ] cloud_roasts has id and slug columns",
        "## Notes",
        "- [ ] the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("does not treat inline bold text in a checkbox as a field boundary", () => {
    const enumeratedResult = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "**Acceptance criteria**",
        "- [ ] creates two **secure** views named roast and reviews",
        "- [ ] both views expose id and slug columns",
        "**In-scope surface**",
      ].join("\n"),
    );
    expect(enumeratedResult.downgraded).toBe(false);

    const boundaryResult = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "**Acceptance criteria**",
        "- [ ] creates two **secure** views named roast and reviews",
        "- [ ] the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(boundaryResult.patternId).toBe("noun-in-section");
  });

  it("downgrades delegation under an ATX AC heading with a suffix", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "## Acceptance criteria (enumerated, diff-verifiable)",
        "- [ ] the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(result.patternId).toBe("noun-in-section");
  });

  it("does not recognize inline bold AC text in prose as a section heading", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "This paragraph mentions **Acceptance criteria** mid-prose.",
        "- [ ] the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });
});

describe("enforceDiffVerifiableAc — false-positive firewall", () => {
  it("N1: ignores both plan-link field forms outside the AC section", () => {
    const enumerated =
      "cloud_roasts exists with columns id, slug, visibility, temperature_celsius";
    const sectionForm = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody(
        enumerated,
        "### Plan link\nplan.md — epic C2, §4; scope matches §4",
      ),
    );
    const inlineForm = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody(
        enumerated,
        "**Plan link:** plan.md — epic C2, §4; scope matches §4",
      ),
    );
    expect(sectionForm.effectiveReadiness).toBe("ready-to-implement");
    expect(inlineForm.effectiveReadiness).toBe("ready-to-implement");
  });

  it("N2/G3: allows parenthetical provenance after an inline enumeration", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody(
        "cloud_roasts exists with columns id, slug, visibility, temperature_celsius (see plan.md §4)",
      ),
    );
    expect(result.downgraded).toBe(false);
  });

  it("allows nested-parenthesis provenance after an inline enumeration", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("schema exists with id and slug columns (see (plan) §4)"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("N3: ignores plan references in later metadata sections", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody(
        "cloud_roasts has id, slug, and visibility columns",
        "",
        "### Verification notes\nCompare to plan.md §4\n### Depends on\nSee section 8",
      ),
    );
    expect(result.effectiveReadiness).toBe("ready-to-implement");
  });

  it("N4/G4: masks delegation-like text inside inline code", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("log the literal header `per §4 header`"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("masks a double-backtick span containing a literal single backtick", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("render ``per §4` literal`` exactly"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("N5: allows bare numbers and numeric ranges", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("ratings accept 1–5 and temperature is at least 4°C"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("allows a legitimate numbered term without a delegation construction", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("expose a Section 508 accessibility label"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("does not bind a per-token across clause punctuation to an unrelated section", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("10 results per page; the section 3 filter applies"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("does not treat a compared runtime .log artifact as an external document", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("latency compared to baseline and logged to file metrics.log"),
    );
    expect(result.downgraded).toBe(false);
  });

  it.each<ReadinessLabel>(["needs-info", "wait-to-implement"])(
    "N6/G7: leaves non-authorizing readiness %s untouched",
    (readiness) => {
      const result = enforceDiffVerifiableAc(
        readiness,
        issueBody("the schema matches §4"),
      );
      expect(result).toEqual({
        effectiveReadiness: readiness,
        downgraded: false,
        patternId: null,
        downgradeNotice: null,
      });
    },
  );

  it("G5-T: passes through an authorizing body with no AC section", () => {
    // This pins the zero-criteria branch directly; the pre-existing bodyless
    // apply-entrypoint fixtures exercise it too, so it is intentionally not
    // the branch's sole catcher.
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      "### Plan link\nplan.md §4",
    );
    expect(result.effectiveReadiness).toBe("ready-to-implement");
    expect(result.downgraded).toBe(false);
  });

  it("passes through an AC heading with zero checkbox criteria", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      "### Acceptance criteria\nNo checkbox criteria yet.\n### Notes\n- pending",
    );
    expect(result.effectiveReadiness).toBe("ready-to-implement");
    expect(result.downgraded).toBe(false);
  });
});

describe("enforceDiffVerifiableAc — normalised body and section boundaries", () => {
  it("G2: scans checkboxes below deeper headings but stops at a same-level sibling", () => {
    const insideDeeperHeading = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] id and slug are emitted inline",
        "#### Details",
        "- [ ] schema matches §4",
        "### Notes",
        "- [ ] ignored",
      ].join("\n"),
    );
    const afterSiblingHeading = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] id and slug are emitted inline",
        "### Notes",
        "- [ ] the schema matches §4",
      ].join("\n"),
    );
    expect(insideDeeperHeading.patternId).toBe("matches-section");
    expect(afterSiblingHeading.downgraded).toBe(false);
  });

  it("keeps HTML-comment delimiters in inline code inert before comment masking", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] emit the literal `<!--` token",
        "- [ ] schema matches §4",
        "- [ ] emit the literal `-->` token",
      ].join("\n"),
    );
    expect(result.patternId).toBe("matches-section");
  });

  it("ignores a tilde-fenced fake heading and evaluates the real AC section", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "~~~markdown",
        "### Acceptance criteria",
        "- [ ] inline example is complete",
        "~~~",
        "### Acceptance criteria",
        "- [ ] schema matches §4",
      ].join("\n"),
    );
    expect(result.patternId).toBe("matches-section");
  });

  it("keeps an inner shorter backtick fence inside a four-backtick fence masked", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "````markdown",
        "```",
        "### Acceptance criteria",
        "- [ ] fake inline example",
        "```",
        "~~~~",
        "### Acceptance criteria",
        "- [ ] fake different-character example",
        "~~~~",
        "````",
        "### Acceptance criteria",
        "- [ ] schema matches §4",
      ].join("\n"),
    );
    expect(result.patternId).toBe("matches-section");
  });

  it("masks an unmatched HTML-comment opener inside a fenced example", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "```markdown",
        "literal example <!--",
        "```",
        "### Acceptance criteria",
        "- [ ] schema matches §4",
      ].join("\n"),
    );
    expect(result.patternId).toBe("matches-section");
  });

  it("does not close a fence on a delimiter run with trailing content", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "```markdown",
        "```not-a-close",
        "### Acceptance criteria",
        "- [ ] fake inline example",
        "```",
        "### Acceptance criteria",
        "- [ ] schema matches §4",
      ].join("\n"),
    );
    expect(result.patternId).toBe("matches-section");
  });

  it("removes hidden HTML-comment delegation text before matching", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("schema exists <!-- matches plan §4 -->"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("keeps a backticked compare-to-file path inert", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      issueBody("compare output to file `plan.md`"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("downgrades an unquoted compare-to-file document path", () => {
    expectDowngrade("compare output to file spec.md", "compare-to-file");
  });
});

describe("enforceDiffVerifiableAc — checkbox continuation lines", () => {
  it("downgrades a per-plan delegation on an indented continuation", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      "### Acceptance criteria\n- [ ] create the schema\n  per plan.md",
    );
    expect(result.patternId).toBe("per-plan");
  });

  it("downgrades a noun-in-section construction spanning a wrap", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] the five tables",
        "  and the columns in plan §4 exist",
      ].join("\n"),
    );
    expect(result.patternId).toBe("noun-in-section");
  });

  it("allows a wrapped pure-enumeration criterion", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] cloud_roasts exists with columns id, slug",
        "  visibility, temperature_celsius",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("allows a provenance citation on a criterion continuation", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] cloud_roasts has columns id, slug, temperature_celsius",
        "  (see plan.md §4)",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });

  it("attributes a post-blank delegation only to the following checkbox", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] cloud_roasts has id and slug columns",
        "",
        "- [ ] create the schema",
        "  per plan.md",
      ].join("\n"),
    );
    expect(result.patternId).toBe("per-plan");
  });

  it("does not aggregate an orphaned continuation after a blank line", () => {
    const result = enforceDiffVerifiableAc(
      "ready-to-implement",
      [
        "### Acceptance criteria",
        "- [ ] cloud_roasts has id and slug columns",
        "",
        "  per plan.md",
        "### Notes",
      ].join("\n"),
    );
    expect(result.downgraded).toBe(false);
  });
});

describe("shared acceptance-criteria pattern identity", () => {
  it("G10: both consumers use all three extracted RegExp objects by reference", () => {
    for (const key of [
      "ACCEPTANCE_CRITERIA_HEADING_LINE_PATTERN",
      "ANY_HEADING_LINE_PATTERN",
      "CHECKBOX_LINE_PATTERN",
    ] as const) {
      expect(diffVerifiableAcModule[key]).toBe(sharedPatterns[key]);
      expect(specGroundingModule[key]).toBe(sharedPatterns[key]);
    }
  });
});
