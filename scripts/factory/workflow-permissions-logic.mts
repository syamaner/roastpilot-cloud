/**
 * Shared effective GitHub Actions permission-declaration resolution.
 *
 * This module resolves workflow/job declaration precedence only. Repository,
 * organization, event, and fork policy can further restrict runtime grants,
 * so an absent declaration remains explicitly unresolved.
 */

const PERMISSION_ACCESS = {
  actions: ["none", "read", "write"],
  "artifact-metadata": ["none", "read", "write"],
  attestations: ["none", "read", "write"],
  checks: ["none", "read", "write"],
  "code-quality": ["none", "read", "write"],
  contents: ["none", "read", "write"],
  deployments: ["none", "read", "write"],
  discussions: ["none", "read", "write"],
  "id-token": ["none", "write"],
  issues: ["none", "read", "write"],
  models: ["none", "read"],
  packages: ["none", "read", "write"],
  pages: ["none", "read", "write"],
  "pull-requests": ["none", "read", "write"],
  "security-events": ["none", "read", "write"],
  statuses: ["none", "read", "write"],
  "vulnerability-alerts": ["none", "read"],
} as const;

/** One currently documented GitHub Actions `GITHUB_TOKEN` scope. */
export type WorkflowPermissionScope = keyof typeof PERMISSION_ACCESS;
/** One supported declared access level. */
export type WorkflowPermissionAccess = "none" | "read" | "write";
/** Declaration level selected by job-over-workflow precedence. */
export type WorkflowPermissionSource = "job" | "workflow";

/**
 * One sorted explicit permission-scope declaration.
 */
export interface WorkflowPermissionScopeEvidence {
  readonly scope: WorkflowPermissionScope;
  readonly access: WorkflowPermissionAccess;
}

/**
 * Canonical effective permission-declaration evidence for one job.
 *
 * Token material is present for every job. `declaredCapability` describes
 * only the selected YAML declaration and does not assert final runtime grants.
 */
export interface EffectiveWorkflowPermissionsEvidence {
  readonly githubTokenMaterialPresent: true;
  readonly declaredCapability:
    | "none"
    | "read"
    | "unresolved-default"
    | "write";
  readonly declaration:
    | { readonly kind: "unresolved-default" }
    | {
        readonly kind: "all";
        readonly access: "read" | "write";
        readonly source: WorkflowPermissionSource;
      }
    | {
        readonly kind: "scopes";
        readonly entries: readonly WorkflowPermissionScopeEvidence[];
        readonly source: WorkflowPermissionSource;
      };
}

/**
 * Effective permission resolution, including conservative malformed input.
 */
export type EffectiveWorkflowPermissionsResolution =
  | {
      readonly kind: "resolved";
      readonly evidence: EffectiveWorkflowPermissionsEvidence;
    }
  | {
      readonly kind: "unanalyzable";
      readonly githubTokenMaterialPresent: true;
      readonly declaredCapability: "unresolved-default";
      readonly detail: string;
    };

/**
 * Explicit job-level permission override state.
 */
export type WorkflowJobPermissionOverride =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPermissionDeclaration(): EffectiveWorkflowPermissionsResolution {
  return {
    kind: "unanalyzable",
    githubTokenMaterialPresent: true,
    declaredCapability: "unresolved-default",
    detail:
      "permission declaration contains an unknown scope, access level, or shape",
  };
}

/**
 * Resolve the permission declaration selected by GitHub's job-over-workflow
 * precedence.
 *
 * A present job declaration replaces the workflow declaration. Absence at
 * both levels yields a distinct conservative default because repository and
 * organization settings are mutable external state.
 *
 * @param workflowValue - Top-level `permissions` value, or `undefined`.
 * @param jobOverride - Whether the job owns a declaration and its exact value.
 * @returns Typed canonical evidence or a conservative malformed result.
 */
export function resolveEffectiveWorkflowPermissions(
  workflowValue: unknown,
  jobOverride: WorkflowJobPermissionOverride,
): EffectiveWorkflowPermissionsResolution {
  const source: WorkflowPermissionSource = jobOverride.present
    ? "job"
    : "workflow";
  const value = jobOverride.present
    ? jobOverride.value
    : workflowValue;
  if (value === undefined && !jobOverride.present) {
    return {
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: "unresolved-default",
        declaration: { kind: "unresolved-default" },
      },
    };
  }
  if (value === "read-all" || value === "write-all") {
    const access = value === "read-all" ? "read" : "write";
    return {
      kind: "resolved",
      evidence: {
        githubTokenMaterialPresent: true,
        declaredCapability: access,
        declaration: { kind: "all", access, source },
      },
    };
  }
  if (!isRecord(value)) {
    return invalidPermissionDeclaration();
  }

  const entries: WorkflowPermissionScopeEvidence[] = [];
  let declaredCapability: "none" | "read" | "write" = "none";
  for (const [scope, access] of Object.entries(value).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (
      !Object.hasOwn(PERMISSION_ACCESS, scope) ||
      typeof access !== "string" ||
      !(
        PERMISSION_ACCESS[
          scope as WorkflowPermissionScope
        ] as readonly string[]
      )
        .includes(access)
    ) {
      return invalidPermissionDeclaration();
    }
    const typedAccess = access as WorkflowPermissionAccess;
    entries.push({
      scope: scope as WorkflowPermissionScope,
      access: typedAccess,
    });
    if (typedAccess === "write") {
      declaredCapability = "write";
    } else if (
      typedAccess === "read" &&
      declaredCapability === "none"
    ) {
      declaredCapability = "read";
    }
  }
  return {
    kind: "resolved",
    evidence: {
      githubTokenMaterialPresent: true,
      declaredCapability,
      declaration: { kind: "scopes", entries, source },
    },
  };
}
