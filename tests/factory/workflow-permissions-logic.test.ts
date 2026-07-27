import { describe, expect, it } from "vitest";

import { resolveEffectiveWorkflowPermissions } from "../../scripts/factory/workflow-permissions-logic.mts";

describe("shared workflow permission resolution (issue #120)", () => {
  it("keeps an absent declaration unresolved and distinct from an empty map", () => {
    const absent = resolveEffectiveWorkflowPermissions(
      undefined,
      { present: false },
    );
    const empty = resolveEffectiveWorkflowPermissions(
      {},
      { present: false },
    );

    expect(absent).toEqual({
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: "unresolved-default",
        declaration: { kind: "unresolved-default" },
      },
    });
    expect(empty).toEqual({
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: "none",
        declaration: {
          kind: "scopes",
          entries: [],
          source: "workflow",
        },
      },
    });
    expect(absent).not.toEqual(empty);
  });

  it("applies job replacement rather than workflow-map merging", () => {
    expect(
      resolveEffectiveWorkflowPermissions(
        { contents: "write" },
        {
          present: true,
          value: { issues: "none" },
        },
      ),
    ).toEqual({
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: "none",
        declaration: {
          kind: "scopes",
          entries: [{ scope: "issues", access: "none" }],
          source: "job",
        },
      },
    });
  });

  it("preserves shorthand modes and read-effective token presence", () => {
    expect(
      resolveEffectiveWorkflowPermissions(
        "read-all",
        { present: false },
      ),
    ).toEqual({
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: "read",
        declaration: {
          kind: "all",
          access: "read",
          source: "workflow",
        },
      },
    });
    expect(
      resolveEffectiveWorkflowPermissions(
        "write-all",
        { present: false },
      ),
    ).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({
          githubTokenMaterialPresent: true,
          declaredCapability: "write",
        }),
      }),
    );
  });

  it("sorts semantically unordered explicit permission scopes", () => {
    const first = resolveEffectiveWorkflowPermissions(
      { issues: "write", contents: "read" },
      { present: false },
    );
    const reordered = resolveEffectiveWorkflowPermissions(
      { contents: "read", issues: "write" },
      { present: false },
    );

    expect(first).toEqual(reordered);
  });

  it.each([
    ["unknown scope", { frobnicate: "none" }],
    ["wrong scope case", { Contents: "read" }],
    ["id-token read", { "id-token": "read" }],
    ["models write", { models: "write" }],
    ["vulnerability alerts write", { "vulnerability-alerts": "write" }],
    ["non-string access", { contents: true }],
    ["unsupported shorthand", "none"],
    ["null declaration", null],
    ["sequence declaration", []],
    ["ordered-map declaration", new Map()],
    ["set declaration", new Set()],
    [
      "class instance declaration",
      new (class PermissionDeclaration {})(),
    ],
  ])("fails closed on %s", (_name, declaration) => {
    expect(
      resolveEffectiveWorkflowPermissions(
        declaration,
        { present: false },
      ),
    ).toEqual({
      kind: "unanalyzable",
      githubTokenMaterialPresent: true,
      declaredCapability: "unresolved-default",
      detail:
        "permission declaration contains an unknown scope, access level, or shape",
    });
  });
});
