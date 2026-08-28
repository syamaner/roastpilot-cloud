import { describe, expect, it } from "vitest";

import {
  deriveIssueCommandAuthorization,
  type IssueCommandAuthorizationInput,
} from "../../scripts/factory/derive-issue-command-authorization.mts";

const REPOSITORY = "syamaner/roastpilot-cloud";

function authorizationInput(
  overrides: Partial<IssueCommandAuthorizationInput> = {},
): IssueCommandAuthorizationInput {
  return {
    issue: { state: "open" },
    repository: { full_name: REPOSITORY, fork: false },
    author: { login: "syamaner" },
    commentBody: "@claude approve",
    githubRepository: REPOSITORY,
    ...overrides,
  };
}

describe("issue owner-command authorization", () => {
  it("M-PARSE admits an owner approve on an open non-PR issue", () => {
    expect(deriveIssueCommandAuthorization(authorizationInput())).toEqual({
      proceed: true,
      command: { verb: "approve", payload: "", truncated: false },
    });
  });

  it("admits the closed issue-command subset positive respec case", () => {
    expect(deriveIssueCommandAuthorization(authorizationInput({
      commentBody: "@claude respec rebuild the contract",
    }))).toEqual({
      proceed: true,
      command: {
        verb: "respec",
        payload: " rebuild the contract",
        truncated: false,
      },
    });
  });

  it("M-OWNER keeps a public-repo stranger inert", () => {
    expect(deriveIssueCommandAuthorization(authorizationInput({
      author: { login: "attacker" },
    }))).toEqual({ proceed: false });
  });

  it("M-PR rejects an issue record that identifies a PR target", () => {
    expect(deriveIssueCommandAuthorization(authorizationInput({
      issue: { state: "open", pull_request: {} },
    }))).toEqual({ proceed: false });
  });

  it.each(["question", "task"])(
    "M-SUBSET rejects the PR-only %s verb",
    (verb) => {
      expect(deriveIssueCommandAuthorization(authorizationInput({
        commentBody: `@claude ${verb} data`,
      }))).toEqual({ proceed: false });
    },
  );

  it.each([
    ["repository mismatch", { repository: { full_name: "attacker/fork", fork: false } }],
    ["fork", { repository: { full_name: REPOSITORY, fork: true } }],
    ["closed issue", { issue: { state: "closed" } }],
    ["unknown command", { commentBody: "@claude deploy" }],
  ] as const)("rejects the valid but ineligible %s case", (_name, overrides) => {
    expect(deriveIssueCommandAuthorization(authorizationInput(overrides)))
      .toEqual({ proceed: false });
  });

  it.each([
    ["issue", { issue: null }],
    ["issue state", { issue: {} }],
    ["pull request marker", { issue: { state: "open", pull_request: null } }],
    ["repository", { repository: null }],
    ["repository fork", { repository: { full_name: REPOSITORY } }],
    ["author", { author: null }],
    ["author login", { author: {} }],
    ["comment body", { commentBody: null }],
  ] as const)("throws loudly on malformed fetched %s", (_name, overrides) => {
    expect(() => deriveIssueCommandAuthorization(
      authorizationInput(overrides as Partial<IssueCommandAuthorizationInput>),
    )).toThrow(TypeError);
  });
});
