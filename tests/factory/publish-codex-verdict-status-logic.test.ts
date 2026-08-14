import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_ADVISORY_STATUS_CONTEXT,
  type RawIssueComment,
  type StatusPlan,
} from "../../scripts/factory/codex-signal-collection-logic.mts";
import { CODEX_BOT_LOGIN } from "../../scripts/factory/codex-verdict-logic.mts";
import {
  CODEX_RETRIGGER_AUTHORIZED_LOGINS,
  filterAuthorizedTriggerComments,
  filterRootReviewComments,
  isAuthorizedTriggerAuthor,
  namespacedStatusContext,
  toNamespacedPlan,
  type NamespacedStatusPlan,
  type RawReviewCommentRecord,
} from "../../scripts/factory/publish-codex-verdict-status-logic.mts";

const CREATED = "2026-08-08T10:00:00Z";
const TRIGGER_BODY = "please @codex review this head";
const STATUS_GRAMMAR = /^(?:clean channel=clean-comment sha=[0-9a-f]{7}|findings source=(?:review|comment) sha=[0-9a-f]{7} count=\d+|pending reasons=[a-z-]+(?:,[a-z-]+)*(?:; omitted=\d+)?; advice=(?:wait|already-posted|not-applicable-draft|due|eyes-stale-escalate|verify)(?:; see AGENTS\.md PR Merge Policy)?)$/u;

function issueComment(
  overrides: Partial<RawIssueComment> = {},
): RawIssueComment {
  return {
    authorLogin: "syamaner",
    body: TRIGGER_BODY,
    createdAt: CREATED,
    id: 1,
    ...overrides,
  };
}

function reviewComment(
  pullRequestReviewId: unknown,
  inReplyToId?: unknown,
): RawReviewCommentRecord {
  return { pullRequestReviewId, inReplyToId };
}

function expectWrite(
  plan: NamespacedStatusPlan,
  state: "success" | "failure" | "pending",
) {
  expect(plan).toMatchObject({ kind: "write", state });
  return plan.kind === "write" ? plan : null;
}

function expectDescription(
  plan: NamespacedStatusPlan,
  state: "success" | "failure" | "pending",
) {
  const write = expectWrite(plan, state);
  expect(write?.description).toMatch(STATUS_GRAMMAR);
  return write;
}

describe("trigger-author authorization", () => {
  it("keeps only the exact allowlisted trigger author", () => {
    // guard G1: removing the authorization check or normalizing bytes breaks this table.
    expect(CODEX_RETRIGGER_AUTHORIZED_LOGINS).toEqual(new Set(["syamaner"]));
    expect(isAuthorizedTriggerAuthor("syamaner")).toBe(true);
    for (const login of ["Syamaner", "syamaner ", "syamaner[bot]"]) {
      expect(isAuthorizedTriggerAuthor(login)).toBe(false);
      expect(filterAuthorizedTriggerComments([issueComment({ authorLogin: login })]))
        .toEqual([]);
    }
    expect(isAuthorizedTriggerAuthor(123)).toBe(false);

    const allowed = issueComment();
    expect(filterAuthorizedTriggerComments([allowed])).toEqual([allowed]);
    expect(filterAuthorizedTriggerComments([allowed])[0]).toBe(allowed);
  });

  it("drops well-formed stranger and non-allowlisted bot triggers", () => {
    const stranger = issueComment({ authorLogin: "stranger" });
    const otherBot = issueComment({ authorLogin: "dependabot[bot]" });
    expect(filterAuthorizedTriggerComments([stranger, otherBot])).toEqual([]);
  });

  it("retains bot-authored quotations and non-trigger comments", () => {
    const codexQuote = issueComment({ authorLogin: CODEX_BOT_LOGIN });
    const ordinary = issueComment({ authorLogin: "stranger", body: "ordinary comment" });
    expect(filterAuthorizedTriggerComments([codexQuote, ordinary]))
      .toEqual([codexQuote, ordinary]);
  });

  it("retains every malformed trigger-shaped record", () => {
    // guard G2: these MUST fail if any field-validity conjunct is removed.
    // Malformed evidence must reach collection and degrade completeness.
    const malformed = [
      issueComment({ authorLogin: 42 }),
      issueComment({ authorLogin: "stranger", body: 42 }),
      issueComment({ authorLogin: "stranger", createdAt: "not-an-instant" }),
      issueComment({ authorLogin: "stranger", id: 0 }),
      null as unknown as RawIssueComment,
    ];
    expect(filterAuthorizedTriggerComments(malformed)).toEqual(malformed);
  });
});

describe("root review-comment classification", () => {
  it("keeps three roots and excludes five replies under one review", () => {
    const comments = [
      reviewComment(7),
      reviewComment(7, undefined),
      reviewComment(7, null),
      ...Array.from({ length: 5 }, (_, index) => reviewComment(7, index + 1)),
    ];
    expect(filterRootReviewComments(comments)).toEqual({
      records: [
        { pullRequestReviewId: 7 },
        { pullRequestReviewId: 7 },
        { pullRequestReviewId: 7 },
      ],
      complete: true,
    });
  });

  it("returns zero complete roots when every comment is a reply", () => {
    expect(filterRootReviewComments([
      reviewComment(9, 1),
      reviewComment(9, Number.MAX_SAFE_INTEGER),
    ])).toEqual({ records: [], complete: true });
  });

  it.each(["0", -1, {}, 1.5])(
    "excludes invalid inReplyToId %o and degrades completeness",
    (inReplyToId) => {
      // guard G3: undecidable roots must never silently shrink a complete snapshot.
      expect(filterRootReviewComments([reviewComment(7, inReplyToId)]))
        .toEqual({ records: [], complete: false });
    },
  );

  it("degrades completeness for a non-record runtime value", () => {
    const hostile = null as unknown as RawReviewCommentRecord;
    expect(filterRootReviewComments([hostile]))
      .toEqual({ records: [], complete: false });
  });
});

describe("PR-namespaced status plans", () => {
  const writePlan: StatusPlan = {
    kind: "write",
    context: CODEX_ADVISORY_STATUS_CONTEXT,
    state: "pending",
    description: "pending reasons=no-bot-signal; advice=wait",
  };

  it("constructs the byte-exact PR context through the namespacing helper", () => {
    const context = namespacedStatusContext(123);
    expect(context).toBe(`${CODEX_ADVISORY_STATUS_CONTEXT}/pr-123`);
    expect(context?.startsWith(`${CODEX_ADVISORY_STATUS_CONTEXT}/`)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    "rejects invalid PR number %o",
    (prNumber) => {
      expect(namespacedStatusContext(prNumber)).toBeNull();
    },
  );

  it("carries state and description through while replacing the context", () => {
    const write = expectDescription(toNamespacedPlan(writePlan, 123), "pending");
    expect(write).toEqual({
      kind: "write",
      context: namespacedStatusContext(123),
      state: writePlan.state,
      description: writePlan.description,
    });
  });

  it("fails closed when a write cannot receive a namespaced context", () => {
    // guard G4: an invalid PR must never fall back to the shared base context.
    const result = toNamespacedPlan(writePlan, 0);
    expect(result).toEqual({ kind: "no-write", reason: "internal-failure" });
    expect(result).not.toMatchObject({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
    });
  });

  it("passes an existing no-write plan through unchanged", () => {
    const noWrite = { kind: "no-write", reason: "fork-head" } as const;
    expect(toNamespacedPlan(noWrite, 0)).toBe(noWrite);
  });
});

describe("purity", () => {
  it("T17 has no forgeable time source or impure identifier in the module", () => {
    const source = readFileSync(
      new URL(
        "../../scripts/factory/publish-codex-verdict-status-logic.mts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /Date\.now|new\s+Date|Math\.random|node:fs|\bfetch\s*\(|\bgithubRequest\b|git(?:Commit|Author)|committedAt/u,
    );
  });
});
