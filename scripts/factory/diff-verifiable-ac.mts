/**
 * Dependency-free deterministic intake guard for diff-verifiable acceptance
 * criteria. This leaf is safe to load in the privileged triage apply process.
 */

import {
  ACCEPTANCE_CRITERIA_HEADING_LINE_PATTERN,
  ANY_HEADING_LINE_PATTERN,
  CHECKBOX_LINE_PATTERN,
} from "./acceptance-criteria-lines.mts";
import type { ReadinessLabel } from "./triage-verdict-schema.mts";

export {
  ACCEPTANCE_CRITERIA_HEADING_LINE_PATTERN,
  ANY_HEADING_LINE_PATTERN,
  CHECKBOX_LINE_PATTERN,
} from "./acceptance-criteria-lines.mts";

export const DELEGATION_PATTERN_IDS = [
  "matches-section",
  "noun-in-section",
  "per-plan",
  "as-in-section",
  "see-section",
  "compare-to-file",
] as const;

export type DelegationPatternId = (typeof DELEGATION_PATTERN_IDS)[number];

export interface DiffVerifiableAcResult {
  readonly effectiveReadiness: ReadinessLabel;
  readonly downgraded: boolean;
  readonly patternId: DelegationPatternId | null;
  readonly downgradeNotice: string | null;
}

const IMPLEMENTATION_AUTHORIZING_READINESS = new Set<ReadinessLabel>([
  "ready-to-implement",
  "ready-for-conventional-implementation",
]);

const ACCEPTANCE_CRITERIA_ATX_PREFIX_PATTERN =
  /^ {0,3}(#{1,6})\s*acceptance criteria\b/i;
const ACCEPTANCE_CRITERIA_BOLD_LABEL_PATTERN =
  /^ {0,3}\*\*\s*acceptance criteria\s*:?\s*\*\*\s*$/i;
const BOLD_FIELD_LABEL_LINE_PATTERN =
  /^ {0,3}\*\*\s*[^*\r\n]+?\s*:?\s*\*\*\s*$/;

const NAMED_CHARACTER_ENTITIES = {
  sect: "§",
  period: ".",
  num: "#",
  sol: "/",
  commat: "@",
  amp: "&",
  lt: "<",
  gt: ">",
} as const;
const CHARACTER_ENTITY_PATTERN =
  /&(?:#(\d+)|#x([0-9a-fA-F]+)|(sect|period|num|sol|commat|amp|lt|gt));/g;

const EXTREF_SOURCE =
  String.raw`(?:§\s*\d+|\bsection\s+\d+\b|\bplan\.md\b|\bplan\s+§\s*\d+)`;
const FILE_EXTREF_SOURCE =
  String.raw`(?:${EXTREF_SOURCE}|\bfile\s+["'\x60]?[\w./-]*\.(?:md|markdown|rst|txt|adoc|asciidoc|pdf|docx?)\b)`;
const GAP_20_SOURCE = String.raw`[^.;\n]{0,20}?`;
const GAP_30_SOURCE = String.raw`[^.;\n]{0,30}?`;
const NOUN_IN_SECTION_SOURCE =
  String.raw`(?:columns?|tables?|fields?|schema|values?|enums?|types?|rows?|constraints?|definitions?|signatures?|secure\s+views?|views?|procedures?|procs?|functions?|grants?|roles?|stages?|tasks?|streams?|sequences?|warehouses?|databases?|schemas?|pipes?|privileges?|migrations?|policies|policy)`;

const DELEGATION_PATTERNS: readonly {
  readonly id: DelegationPatternId;
  readonly pattern: RegExp;
}[] = [
  {
    id: "matches-section",
    pattern: new RegExp(
      String.raw`\bmatch(?:es|ing|ed)?\b${GAP_30_SOURCE}${EXTREF_SOURCE}`,
      "i",
    ),
  },
  {
    id: "noun-in-section",
    pattern: new RegExp(
      String.raw`\b${NOUN_IN_SECTION_SOURCE}\b${GAP_20_SOURCE}\bin\b${GAP_20_SOURCE}${EXTREF_SOURCE}`,
      "i",
    ),
  },
  {
    id: "per-plan",
    pattern: new RegExp(
      String.raw`\bper\b${GAP_20_SOURCE}${EXTREF_SOURCE}`,
      "i",
    ),
  },
  {
    id: "as-in-section",
    pattern: new RegExp(
      String.raw`\bas\s+(?:specified|defined|listed|described|enumerated|documented|detailed|given|shown)\s+in\b${GAP_20_SOURCE}${EXTREF_SOURCE}`,
      "i",
    ),
  },
  {
    id: "see-section",
    pattern: new RegExp(
      String.raw`\bsee\b${GAP_20_SOURCE}${EXTREF_SOURCE}`,
      "i",
    ),
  },
  {
    id: "compare-to-file",
    pattern: new RegExp(
      String.raw`\bcompar(?:e|es|ed|ing)\b${GAP_20_SOURCE}\b(?:to|with|against)\b${GAP_30_SOURCE}${FILE_EXTREF_SOURCE}`,
      "i",
    ),
  },
];

// Deliberate precision/recall boundary: a phrase such as "types render in
// under section 5 latency budget" can still resemble noun-in-section even
// when "section 5" names a budget rather than an external document. This
// additive guard accepts that recoverable availability-only false positive;
// making the grammar infer prose semantics would weaken its determinism.
// Two further by-design residuals are operator-accepted and tracked in #326:
// inline-code external references stay inert under N4 (treating them as
// operative would reverse that allow-case), and vague prose plus a trailing
// or parenthetical citation cannot be distinguished deterministically from an
// enumerated criterion with provenance without introducing false positives.

// This dependency-free, precision-first normalisation is deliberately not a
// full CommonMark parser: markdown-it stays out of the credentialed apply
// process. Pathological fence/comment/list nesting beyond the handled cases
// may let a delegation escape. That safe-direction residual is bounded by the
// retained LLM triage, human merge, and domain review overlays and tracked in
// #326; do not grow this leaf into a second Markdown implementation.
// The named-entity decoder likewise covers the common grammar-relevant subset;
// exotic named entities outside that map are a bounded safe-direction residual
// tracked in #326. Numeric entities are decoded generally.

function decodeNumericEntity(digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  if (codePoint > 0x10ffff) {
    return "\uFFFD";
  }
  return String.fromCodePoint(codePoint);
}

function decodeCharacterEntities(body: string): string {
  return body.replace(
    CHARACTER_ENTITY_PATTERN,
    (
      _entity: string,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      named: string | undefined,
    ) => {
      if (decimal !== undefined) {
        return decodeNumericEntity(decimal, 10);
      }
      if (hexadecimal !== undefined) {
        return decodeNumericEntity(hexadecimal, 16);
      }
      return NAMED_CHARACTER_ENTITIES[
        named as keyof typeof NAMED_CHARACTER_ENTITIES
      ];
    },
  );
}

function maskHtmlComments(body: string): string {
  let masked = "";
  let inComment = false;
  for (let i = 0; i < body.length; ) {
    if (!inComment && body.startsWith("<!--", i)) {
      masked += "    ";
      i += 4;
      inComment = true;
      continue;
    }
    if (inComment && body.startsWith("-->", i)) {
      masked += "   ";
      i += 3;
      inComment = false;
      continue;
    }
    /* v8 ignore next -- i < body.length guarantees an indexed character. */
    const char = body[i] ?? "";
    masked += inComment && char !== "\r" && char !== "\n" ? " " : char;
    i += 1;
  }
  return masked;
}

function maskFencedCodeBlocks(body: string): string {
  const lines = body.split("\n");
  let openFence: { readonly character: string; readonly runLength: number } | null =
    null;
  return lines
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const fenceRun = fenceMatch?.[1];
      if (openFence !== null) {
        if (
          fenceRun !== undefined &&
          fenceRun[0] === openFence.character &&
          fenceRun.length >= openFence.runLength &&
          /* v8 ignore start -- defined fenceRun guarantees a non-null match whose (.*) group captures a string. */
          (fenceMatch?.[2] ?? "").trim().length === 0
          /* v8 ignore stop */
        ) {
          openFence = null;
        }
        return " ".repeat(line.length);
      }
      if (fenceRun !== undefined) {
        openFence = {
          /* v8 ignore next -- the matched fence run contains at least three characters. */
          character: fenceRun[0] ?? "",
          runLength: fenceRun.length,
        };
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}

function buildNormalisedBodyLines(body: string): string[] {
  const entityDecoded = decodeCharacterEntities(body);
  const inlineCodeMasked = entityDecoded
    .split(/\r?\n/)
    .map((line) => maskInlineCodeSpans(line))
    .join("\n");
  const fenceMasked = maskFencedCodeBlocks(inlineCodeMasked);
  return maskHtmlComments(fenceMasked).split("\n");
}

function extractAcceptanceCriteria(body: string): string[] {
  const normalisedLines = buildNormalisedBodyLines(body);
  let section:
    | {
        readonly kind: "atx";
        readonly headingIndex: number;
        readonly headingLevel: number;
      }
    | { readonly kind: "bold-label"; readonly headingIndex: number }
    | null = null;

  for (let i = 0; i < normalisedLines.length; i += 1) {
    /* v8 ignore next -- the loop bound guarantees normalisedLines[i] exists. */
    const line = normalisedLines[i] ?? "";
    const atxMatch =
      ACCEPTANCE_CRITERIA_HEADING_LINE_PATTERN.exec(line) ??
      ACCEPTANCE_CRITERIA_ATX_PREFIX_PATTERN.exec(line);
    const hashes = atxMatch?.[1];
    if (hashes !== undefined) {
      section = {
        kind: "atx",
        headingIndex: i,
        headingLevel: hashes.length,
      };
      break;
    }
    if (ACCEPTANCE_CRITERIA_BOLD_LABEL_PATTERN.test(line)) {
      section = { kind: "bold-label", headingIndex: i };
      break;
    }
  }
  if (section === null) {
    return [];
  }

  const criteria: string[] = [];
  for (let i = section.headingIndex + 1; i < normalisedLines.length; i += 1) {
    /* v8 ignore next -- the loop bound guarantees normalisedLines[i] exists. */
    const normalisedLine = normalisedLines[i] ?? "";
    const checkboxMatch = CHECKBOX_LINE_PATTERN.exec(normalisedLine);
    if (checkboxMatch === null) {
      const headingHashes = ANY_HEADING_LINE_PATTERN.exec(normalisedLine)?.[1];
      if (
        (section.kind === "atx" &&
          headingHashes !== undefined &&
          headingHashes.length <= section.headingLevel) ||
        (section.kind === "bold-label" &&
          (headingHashes !== undefined ||
            BOLD_FIELD_LABEL_LINE_PATTERN.test(normalisedLine)))
      ) {
        break;
      }
    }
    const text = checkboxMatch?.[2]?.trim();
    if (text !== undefined && text.length > 0) {
      const criterionLines = [text];
      let continuationIndex = i + 1;
      while (continuationIndex < normalisedLines.length) {
        /* v8 ignore next -- the while bound guarantees this indexed line exists. */
        const continuationLine = normalisedLines[continuationIndex] ?? "";
        if (
          continuationLine.trim().length === 0 ||
          CHECKBOX_LINE_PATTERN.test(continuationLine) ||
          ANY_HEADING_LINE_PATTERN.test(continuationLine) ||
          BOLD_FIELD_LABEL_LINE_PATTERN.test(continuationLine)
        ) {
          break;
        }
        criterionLines.push(continuationLine.trim());
        continuationIndex += 1;
      }
      criteria.push(criterionLines.join(" "));
      i = continuationIndex - 1;
    }
  }
  return criteria;
}

function maskInlineCodeSpans(text: string): string {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== "`") {
      continue;
    }
    let openingEnd = i;
    while (chars[openingEnd + 1] === "`") {
      openingEnd += 1;
    }
    const runLength = openingEnd - i + 1;
    let closingStart = openingEnd + 1;
    while (closingStart < chars.length) {
      if (chars[closingStart] !== "`") {
        closingStart += 1;
        continue;
      }
      let closingEnd = closingStart;
      while (chars[closingEnd + 1] === "`") {
        closingEnd += 1;
      }
      if (closingEnd - closingStart + 1 === runLength) {
        for (let j = i; j <= closingEnd; j += 1) {
          chars[j] = " ";
        }
        i = closingEnd;
        break;
      }
      closingStart = closingEnd + 1;
    }
  }
  return chars.join("");
}

function findDelegationPattern(text: string): DelegationPatternId | null {
  const withoutParentheses = text.replace(/\([^)]*\)/g, "");
  const normalised =
    withoutParentheses.trim().length === 0 ? text : withoutParentheses;
  for (const { id, pattern } of DELEGATION_PATTERNS) {
    if (pattern.test(normalised)) {
      return id;
    }
  }
  return null;
}

function buildDowngradeNotice(
  originalReadiness: ReadinessLabel,
  patternId: DelegationPatternId,
): string {
  return (
    `Automated intake downgrade: readiness reduced from \`${originalReadiness}\` ` +
    "to `ready-to-spec`. An acceptance criterion delegates its verifiable " +
    `content to an external document (matched: \`${patternId}\`). Rewrite ` +
    "the criterion to enumerate the observable property inline so it is " +
    "verifiable from the diff (F1-S6 diff-verifiable-AC law, #319)."
  );
}

/** Downgrades implementation-authorizing readiness when an AC delegates. */
export function enforceDiffVerifiableAc(
  readiness: ReadinessLabel,
  body: string,
): DiffVerifiableAcResult {
  if (!IMPLEMENTATION_AUTHORIZING_READINESS.has(readiness)) {
    return {
      effectiveReadiness: readiness,
      downgraded: false,
      patternId: null,
      downgradeNotice: null,
    };
  }

  const criteria = extractAcceptanceCriteria(body);
  for (const criterion of criteria) {
    const patternId = findDelegationPattern(criterion);
    if (patternId !== null) {
      return {
        effectiveReadiness: "ready-to-spec",
        downgraded: true,
        patternId,
        downgradeNotice: buildDowngradeNotice(readiness, patternId),
      };
    }
  }

  return {
    effectiveReadiness: readiness,
    downgraded: false,
    patternId: null,
    downgradeNotice: null,
  };
}
