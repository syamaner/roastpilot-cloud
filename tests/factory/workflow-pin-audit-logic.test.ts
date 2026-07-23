import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
} from "yaml";
import {
  EXPECTED_CLAUDE_CODE_ACTION_SHA,
  findUnpinnedActionReferences,
  findWildcardAllowlistUsages,
  findWorkflowPinViolations,
  isWorkflowPinAuditManifestPath,
} from "../../scripts/factory/workflow-pin-audit-logic.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GITHUB_DIR = join(REPOSITORY_ROOT, ".github");
const WORKFLOWS_DIR = join(GITHUB_DIR, "workflows");
const ACTIONS_DIR = join(GITHUB_DIR, "actions");
const WORKFLOW_FIXTURE_PATH = ".github/workflows/review.yml";
const COMPOSITE_FIXTURE_PATH = ".github/actions/review/action.yml";

function listFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function repositoryRelativePath(path: string): string {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

function withTemporaryRepository(
  run: (repositoryRoot: string) => void,
): void {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "workflow-pin-audit-"),
  );
  try {
    run(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
}

function writeActionManifest(
  repositoryRoot: string,
  actionName: string,
  extension: "yml" | "yaml" = "yml",
  content = "name: fixture\nruns:\n  using: composite\n  steps: []\n",
): string {
  const actionDirectory = join(
    repositoryRoot,
    ".github",
    "actions",
    actionName,
  );
  mkdirSync(actionDirectory, { recursive: true });
  const manifestPath = join(actionDirectory, `action.${extension}`);
  writeFileSync(manifestPath, content);
  return manifestPath;
}

function manifestUsesPinnedClaudeAction(
  repositoryPath: string,
  fileContent: string,
): boolean {
  const document = parseDocument(fileContent);
  const normalizedPath = repositoryPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  const isWorkflowManifest =
    /^\.github\/workflows\/.+\.ya?ml$/i.test(normalizedPath);
  const isCompositeManifest =
    /^\.github\/actions\/(?:.+\/)?action\.ya?ml$/i.test(normalizedPath);
  const resolveNode = (value: unknown): Node | undefined => {
    if (!isNode(value)) {
      return undefined;
    }
    return isAlias(value) ? value.resolve(document) : value;
  };
  const mappingValue = (
    mappingNode: Node | undefined,
    key: string,
  ): Node | undefined => {
    const mapping = resolveNode(mappingNode);
    if (!isMap(mapping)) {
      return undefined;
    }
    for (const pair of mapping.items) {
      const resolvedKey = resolveNode(pair.key);
      if (isScalar(resolvedKey) && resolvedKey.value === key) {
        return resolveNode(pair.value);
      }
    }
    return undefined;
  };
  const stepUsesPinnedAction = (stepNode: unknown): boolean => {
    const uses = mappingValue(resolveNode(stepNode), "uses");
    if (!isScalar(uses) || typeof uses.value !== "string") {
      return false;
    }
    const [actionPath, ref, ...extraAtSegments] = uses.value
      .trim()
      .split("@");
    const pathSegments = actionPath
      .split(/[\\/]/)
      .filter((segment) => segment.length > 0);
    return Boolean(
      extraAtSegments.length === 0 &&
        pathSegments.length === 2 &&
        `${pathSegments[0]}/${pathSegments[1]}`.toLowerCase() ===
          "anthropics/claude-code-action" &&
        typeof ref === "string" &&
        ref.toLowerCase() === EXPECTED_CLAUDE_CODE_ACTION_SHA.toLowerCase(),
    );
  };
  const stepsUsePinnedAction = (stepsNode: Node | undefined): boolean => {
    const steps = resolveNode(stepsNode);
    return (
      isSeq(steps) &&
      steps.items.some((step) => stepUsesPinnedAction(step))
    );
  };

  const root = resolveNode(document.contents);
  if (isWorkflowManifest) {
    const jobs = resolveNode(mappingValue(root, "jobs"));
    return Boolean(
      isMap(jobs) &&
        jobs.items.some((job) =>
          stepsUsePinnedAction(mappingValue(resolveNode(job.value), "steps")),
        ),
    );
  }
  if (!isCompositeManifest) {
    return false;
  }

  const runs = resolveNode(mappingValue(root, "runs"));
  const using = mappingValue(runs, "using");
  return Boolean(
    isScalar(using) &&
      typeof using.value === "string" &&
      using.value === "composite" &&
      stepsUsePinnedAction(mappingValue(runs, "steps")),
  );
}

describe("manifestUsesPinnedClaudeAction", () => {
  it.each([
    [
      WORKFLOW_FIXTURE_PATH,
      `env:\n  IMPLEMENT_AGENT_ACTION_REF: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `# uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\nsteps: []\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `env:\n  uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `metadata:\n  uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `steps:\n  - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `jobs:\n  review:\n    uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `jobs:\n  review:\n    steps:\n      - uses: attacker/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      "jobs:\n  review:\n    steps:\n      - uses: anthropics/claude-code-action@main\n",
    ],
    [
      WORKFLOW_FIXTURE_PATH,
      `runs:\n  using: composite\n  steps:\n    - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      COMPOSITE_FIXTURE_PATH,
      `jobs:\n  review:\n    steps:\n      - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      COMPOSITE_FIXTURE_PATH,
      `runs:\n  steps:\n    - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
    [
      COMPOSITE_FIXTURE_PATH,
      `runs:\n  using: node20\n  steps:\n    - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}\n`,
    ],
  ])(
    "does not count a non-invocation as a live action use",
    (path, content) => {
      expect(manifestUsesPinnedClaudeAction(path, content)).toBe(false);
    },
  );

  it("counts an alias-backed pinned workflow action step", () => {
    const content = [
      "env:",
      `  REVIEW_ACTION: &review-action anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
      "jobs:",
      "  review:",
      "    steps:",
      "      - uses: *review-action",
    ].join("\n");
    expect(
      manifestUsesPinnedClaudeAction(WORKFLOW_FIXTURE_PATH, content),
    ).toBe(true);
  });

  it("counts a pinned composite action step", () => {
    const content = [
      "runs:",
      "  using: composite",
      "  steps:",
      `    - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
    ].join("\n");
    expect(
      manifestUsesPinnedClaudeAction(COMPOSITE_FIXTURE_PATH, content),
    ).toBe(true);
  });
});

describe("isWorkflowPinAuditManifestPath (issue #102)", () => {
  it.each([
    ".github/workflows/review.yml",
    ".github/workflows/nested/review.yaml",
    ".github/actions/action.yml",
    ".github/actions/review/action.yml",
    ".github/actions/review/nested/action.yaml",
    ".github\\actions\\review\\action.yml",
  ])("includes audited workflow or composite manifest %s", (path) => {
    expect(isWorkflowPinAuditManifestPath(path)).toBe(true);
  });

  it.each([
    ".github/actions/review/metadata.yml",
    ".github/workflows/review.json",
    "examples/.github/workflows/review.yml",
  ])("excludes non-audited path %s", (path) => {
    expect(isWorkflowPinAuditManifestPath(path)).toBe(false);
  });
});

describe("local action policy (issue #114)", () => {
  it.each([
    "./.github/actions/review",
    String.raw`.\.github\actions\review`,
    "./.github/actions/./review",
    "./.github/actions/nested/../review",
  ])("accepts an allowed normalized local action path %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findWorkflowPinViolations(content)).toEqual([]);
  });

  it.each([
    "./actions/review",
    String.raw`.\actions\review`,
    "./.github/workflows/review",
    "./.github/actions/../../actions/review",
    "./",
  ])("rejects a local action outside the protected root: %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findWorkflowPinViolations(content)).toEqual([
      expect.objectContaining({
        kind: "unsafe-local-action",
        line: 2,
        detail: expect.stringContaining(
          'must stay within "./.github/actions/**"',
        ),
      }),
    ]);
  });

  it("rejects an alias-backed outside-root local action at the use site", () => {
    const content = [
      "action: &local-action ./actions/review",
      "steps:",
      "  - uses: *local-action",
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([
      expect.objectContaining({
        kind: "unsafe-local-action",
        line: 3,
      }),
    ]);
  });

  it("rejects an outside-root action in an alias-backed steps sequence", () => {
    const content = [
      "shared_steps: &shared-steps",
      "  - uses: ./actions/review",
      "jobs:",
      "  review:",
      "    steps: *shared-steps",
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([
      expect.objectContaining({
        kind: "unsafe-local-action",
        line: 2,
      }),
    ]);
  });

  it("does not classify a job-level local reusable workflow as an action", () => {
    const content = [
      "jobs:",
      "  reusable:",
      "    uses: ./.github/workflows/reusable.yml",
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([]);
  });

  it("ignores non-sequence steps and non-mapping step items", () => {
    const content = [
      "metadata:",
      "  steps: not-a-sequence",
      "other:",
      "  steps:",
      "    - not-a-step-mapping",
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([]);
  });

  it.each(["yml", "yaml"] as const)(
    "accepts exactly one regular action.%s manifest",
    (extension) => {
      withTemporaryRepository((repositoryRoot) => {
        writeActionManifest(repositoryRoot, "review", extension);
        const content = "steps:\n  - uses: ./.github/actions/review\n";
        expect(
          findWorkflowPinViolations(content, repositoryRoot),
        ).toEqual([]);
      });
    },
  );

  it("accepts a genuinely nested local action target", () => {
    withTemporaryRepository((repositoryRoot) => {
      writeActionManifest(repositoryRoot, "group/review");
      const content =
        "steps:\n  - uses: ./.github/actions/group/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual(
        [],
      );
    });
  });

  it.each([
    ["missing target", "does not exist"],
    ["target with no manifest", "found 0"],
  ])("rejects a %s", (_name, detail) => {
    withTemporaryRepository((repositoryRoot) => {
      if (detail === "found 0") {
        mkdirSync(
          join(repositoryRoot, ".github", "actions", "review"),
          { recursive: true },
        );
      }
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining(detail),
        }),
      ]);
    });
  });

  it("rejects a non-directory target", () => {
    withTemporaryRepository((repositoryRoot) => {
      const actionsRoot = join(repositoryRoot, ".github", "actions");
      mkdirSync(actionsRoot, { recursive: true });
      writeFileSync(join(actionsRoot, "review"), "not a directory");
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("must be a directory"),
        }),
      ]);
    });
  });

  it("rejects multiple action manifest extensions in one target", () => {
    withTemporaryRepository((repositoryRoot) => {
      writeActionManifest(repositoryRoot, "review", "yml");
      writeActionManifest(repositoryRoot, "review", "yaml");
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("found 2"),
        }),
      ]);
    });
  });

  it("rejects a symlinked action-directory component", () => {
    withTemporaryRepository((repositoryRoot) => {
      const outsideDirectory = join(repositoryRoot, "outside");
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(join(outsideDirectory, "action.yml"), "name: outside\n");
      const actionsRoot = join(repositoryRoot, ".github", "actions");
      mkdirSync(actionsRoot, { recursive: true });
      symlinkSync(outsideDirectory, join(actionsRoot, "review"));
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("contains symlink component"),
        }),
      ]);
    });
  });

  it("rejects an intermediate symlinked directory component", () => {
    withTemporaryRepository((repositoryRoot) => {
      const outsideGroup = join(repositoryRoot, "outside", "group");
      const outsideAction = join(outsideGroup, "review");
      mkdirSync(outsideAction, { recursive: true });
      writeFileSync(join(outsideAction, "action.yml"), "name: outside\n");
      const actionsRoot = join(repositoryRoot, ".github", "actions");
      mkdirSync(actionsRoot, { recursive: true });
      symlinkSync(outsideGroup, join(actionsRoot, "group"));
      const content =
        "steps:\n  - uses: ./.github/actions/group/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("contains symlink component"),
        }),
      ]);
    });
  });

  it("rejects a symlinked action manifest", () => {
    withTemporaryRepository((repositoryRoot) => {
      const actionDirectory = join(
        repositoryRoot,
        ".github",
        "actions",
        "review",
      );
      mkdirSync(actionDirectory, { recursive: true });
      writeFileSync(join(actionDirectory, "real.yml"), "name: fixture\n");
      symlinkSync(
        join(actionDirectory, "real.yml"),
        join(actionDirectory, "action.yml"),
      );
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("contains symlink manifest"),
        }),
      ]);
    });
  });

  it("rejects a mixed-case action manifest consistently across filesystems", () => {
    withTemporaryRepository((repositoryRoot) => {
      const actionDirectory = join(
        repositoryRoot,
        ".github",
        "actions",
        "review",
      );
      mkdirSync(actionDirectory, { recursive: true });
      writeFileSync(join(actionDirectory, "Action.yml"), "name: fixture\n");
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("exact lowercase name"),
        }),
      ]);
    });
  });

  it("rejects a non-regular action manifest", () => {
    withTemporaryRepository((repositoryRoot) => {
      const actionDirectory = join(
        repositoryRoot,
        ".github",
        "actions",
        "review",
      );
      mkdirSync(join(actionDirectory, "action.yml"), { recursive: true });
      const content = "steps:\n  - uses: ./.github/actions/review\n";
      expect(findWorkflowPinViolations(content, repositoryRoot)).toEqual([
        expect.objectContaining({
          kind: "unsafe-local-action",
          detail: expect.stringContaining("must be a regular file"),
        }),
      ]);
    });
  });

  it("audits nested cyclic local actions independently", () => {
    withTemporaryRepository((repositoryRoot) => {
      const actionA = writeActionManifest(
        repositoryRoot,
        "a",
        "yml",
        "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/b\n",
      );
      const actionB = writeActionManifest(
        repositoryRoot,
        "b",
        "yaml",
        "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/a\n",
      );
      expect(
        [actionA, actionB].flatMap((path) =>
          findWorkflowPinViolations(
            readFileSync(path, "utf8"),
            repositoryRoot,
          ),
        ),
      ).toEqual([]);
    });
  });
});

describe("findUnpinnedActionReferences (issue #102)", () => {
  it("accepts the expected action pin and its case-insensitive equivalent", () => {
    const upperSha = EXPECTED_CLAUDE_CODE_ACTION_SHA.toUpperCase();
    const content = [
      "steps:",
      `  - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
      `  - uses: Anthropics/Claude-Code-Action@${upperSha}`,
      String.raw`  - uses: anthropics\claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
      `  - uses: anthropics//claude-code-action/@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("flags a mixed-case repository with a floating ref", () => {
    const content = [
      "steps:",
      "  - uses: Anthropics/Claude-Code-Action@main",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("@main"),
      }),
    ]);
  });

  it.each([
    "attacker/claude-code-action@main",
    `evilanthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
  ])("rejects wrong repository identity %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining(reference),
      }),
    ]);
  });

  it.each([
    "attacker/claude-code-action/subdir@main",
    `anthropics/claude-code-action/subdir@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
    `Anthropics/Claude-Code-Action/nested/action@${EXPECTED_CLAUDE_CODE_ACTION_SHA.toUpperCase()}`,
    String.raw`anthropics\claude-code-action\subdir@main`,
    String.raw`anthropics/claude-code-action\subdir@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
  ])("rejects subdirectory action reference %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining(reference),
      }),
    ]);
  });

  it.each([
    String.raw`anthropics\claude-code-action@main`,
    String.raw`attacker\claude-code-action@main`,
    "anthropics//claude-code-action@main",
    "anthropics/claude-code-action/@main",
    "anthropics///claude-code-action///@main",
  ])("rejects runner-equivalent mutable action reference %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining(reference),
      }),
    ]);
  });

  it.each(["v1", "abc123", "1".repeat(40)])(
    "flags non-approved ref %s",
    (ref) => {
      const content = `steps:\n  - uses: anthropics/claude-code-action@${ref}\n`;
      expect(findUnpinnedActionReferences(content)).toHaveLength(1);
    },
  );

  it("flags a mutable suffix on the approved SHA", () => {
    const content = `steps:\n  - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}-main\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(
          `${EXPECTED_CLAUDE_CODE_ACTION_SHA}-main`,
        ),
      }),
    ]);
  });

  it.each(["#mutable", "'mutable", '"mutable'])(
    "does not truncate decoded ref suffix %s",
    (suffix) => {
      const reference = `anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}${suffix}`;
      const content = `steps:\n  - uses: '${reference.replaceAll("'", "''")}'\n`;
      expect(findUnpinnedActionReferences(content)).toEqual([
        expect.objectContaining({
          kind: "unpinned-action",
          detail: expect.stringContaining(
            `${EXPECTED_CLAUDE_CODE_ACTION_SHA}${suffix}`,
          ),
        }),
      ]);
    },
  );

  it("preserves the duplicated provenance-scalar invariant", () => {
    const driftedSha = "2".repeat(40);
    const content = [
      "env:",
      `  IMPLEMENT_AGENT_ACTION_REF: "anthropics/claude-code-action@${driftedSha}"`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 2 }),
    ]);
  });

  it("rejects an owner-prefix lookalike in the dedicated provenance field", () => {
    const content = [
      "env:",
      `  IMPLEMENT_AGENT_ACTION_REF: "evilanthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("evilanthropics"),
      }),
    ]);
  });

  it("rejects a non-string dedicated provenance value", () => {
    const content = "env:\n  IMPLEMENT_AGENT_ACTION_REF: [invalid]\n";
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("non-string"),
      }),
    ]);
  });

  it("still rejects drifted action refs in other embedded scalars", () => {
    const content = [
      "metadata:",
      '  OTHER_ACTION_REF: "anthropics/claude-code-action@main"',
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining('"main"'),
      }),
    ]);
  });

  it("accepts a correctly pinned action ref in another embedded scalar", () => {
    const content = [
      "metadata:",
      `  OTHER_ACTION_REF: "anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("resolves an aliased action reference structurally", () => {
    const content = [
      "action: &review-action Anthropics/Claude-Code-Action@main",
      "steps:",
      "  - uses: *review-action",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 3 }),
    ]);
  });

  it("rejects an alias-backed subdirectory action reference", () => {
    const content = [
      "action: &review-action attacker/claude-code-action/subdir@main",
      "steps:",
      "  - uses: *review-action",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 3 }),
    ]);
  });

  it("rejects an alias-backed action reference with runner separators", () => {
    const reference = String.raw`anthropics\claude-code-action\subdir@main`;
    const content = [
      `action: &review-action ${reference}`,
      "steps:",
      "  - uses: *review-action",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 3 }),
    ]);
  });

  it("does not inspect comments as action references", () => {
    const content =
      "# uses: anthropics/claude-code-action@main\nsteps: []\n";
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("does not classify local action paths containing @ as remote actions", () => {
    const content = [
      "steps:",
      "  - uses: ./claude-code-action@main",
      String.raw`  - uses: .\claude-code-action@main`,
      "  - uses: docker://node:20",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("does not crash on non-string keys or non-scalar uses values", () => {
    const content = ["1: unrelated", "uses: [not, a, scalar]"].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });
});

describe("findWildcardAllowlistUsages (issue #102)", () => {
  it("accepts explicit and intentionally empty allowlists", () => {
    const content = [
      "with:",
      "  allowed_bots: claude,claude[bot]",
      '  allowed_non_write_users: ""',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("accepts an explicit sequence, including an empty YAML item", () => {
    const content = [
      "with:",
      "  allowed_bots:",
      "    -",
      "    - claude[bot]",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags a wildcard behind a quoted key", () => {
    const content = 'with:\n  "allowed_bots": "*"\n';
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it.each(["ALLOWED_BOTS", "Allowed_Non_Write_Users"])(
    "normalizes mixed-case action input key %s",
    (key) => {
      const content = `with:\n  ${key}: "*"\n`;
      expect(findWildcardAllowlistUsages(content)).toEqual([
        expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
      ]);
    },
  );

  it("flags a wildcard scalar through an anchor and alias", () => {
    const content = [
      'wildcard: &wildcard "*"',
      "with:",
      "  allowed_non_write_users: *wildcard",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 3 }),
    ]);
  });

  it("flags a wildcard behind an aliased allowlist key", () => {
    const content = [
      "allowlist-key: &allowlist-key allowed_bots",
      "with:",
      '  *allowlist-key : "*"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 3 }),
    ]);
  });

  it("handles a cyclic allowlist alias without recursing indefinitely", () => {
    const content = "with:\n  allowed_bots: &cycle [*cycle]\n";
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags an allowlist key inside an anchored mapping", () => {
    const content = [
      "defaults: &defaults",
      '  allowed_bots: "*"',
      "with: *defaults",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it("flags an explicitly tagged string wildcard", () => {
    const content = 'with:\n  allowed_bots: !!str "*"\n';
    expect(findWildcardAllowlistUsages(content)).toHaveLength(1);
  });

  it("flags a wildcard in a flow mapping and sequence", () => {
    const content =
      'with: { allowed_bots: ["claude[bot]", "*"], other: value }\n';
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 1 }),
    ]);
  });

  it("flags a wildcard in a block scalar", () => {
    const content = ["with:", "  allowed_bots: |-", "    *"].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it("flags a YAML-escaped wildcard", () => {
    const content = 'with:\n  allowed_bots: "\\x2A"\n';
    expect(content).not.toContain("*");
    expect(findWildcardAllowlistUsages(content)).toHaveLength(1);
  });

  it("reports the wildcard list item line", () => {
    const content = [
      "with:",
      "  allowed_bots:",
      "    - claude[bot]",
      '    - "*"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 4 }),
    ]);
  });

  it.each([
    ["allowed_bots", "${{ '*' }}"],
    ["allowed_non_write_users", "${{ vars.ALLOWED_USERS }}"],
    ["allowed_bots", "claude[bot],${{ vars.ALLOWED_BOTS }}"],
  ])("rejects a dynamic %s value %s", (key, value) => {
    const content = `with:\n  ${key}: "${value}"\n`;
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({
        kind: "wildcard-allowlist",
        line: 2,
        detail: expect.stringContaining("dynamic GitHub expression"),
      }),
    ]);
  });

  it("rejects an alias-backed dynamic allowlist sequence item", () => {
    const content = [
      'dynamic: &dynamic "${{ vars.ALLOWED_BOTS }}"',
      "with:",
      "  allowed_bots:",
      "    - claude[bot]",
      "    - *dynamic",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({
        kind: "wildcard-allowlist",
        line: 5,
        detail: expect.stringContaining("dynamic GitHub expression"),
      }),
    ]);
  });

  it("does not flag wildcards on unrelated keys or in comments", () => {
    const content = [
      "with:",
      '  file_glob: "*"',
      '  allowed_bots: claude # not "*"',
      '  other_input: "${{ vars.ALLOWED_BOTS }}"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("does not treat a mapping-valued allowlist as a wildcard scalar", () => {
    const content = 'with:\n  allowed_bots: { pattern: "*" }\n';
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });
});

describe("findWorkflowPinViolations (issue #102)", () => {
  it("combines action and allowlist findings in source order", () => {
    const content = [
      "steps:",
      "  - uses: anthropics/claude-code-action@main",
      "    with:",
      '      allowed_bots: "*"',
    ].join("\n");
    const violations = findWorkflowPinViolations(content);
    expect(violations.map((violation) => violation.kind)).toEqual([
      "unpinned-action",
      "wildcard-allowlist",
    ]);
    expect(violations.map((violation) => violation.line)).toEqual([2, 4]);
  });

  it("fails closed on malformed YAML", () => {
    const content = 'steps:\n  - uses: "unterminated\n';
    const violations = findWorkflowPinViolations(content);
    expect(violations).toEqual([
      expect.objectContaining({
        kind: "invalid-yaml",
        line: 3,
        detail: expect.stringContaining("invalid YAML"),
      }),
    ]);
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "invalid-yaml" }),
    ]);
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "invalid-yaml" }),
    ]);
  });

  it("fails closed on an unquoted bare wildcard, which YAML treats as an invalid alias", () => {
    const violations = findWorkflowPinViolations(
      "with:\n  allowed_bots: *\n",
    );
    expect(violations).toEqual([
      expect.objectContaining({ kind: "invalid-yaml", line: 2 }),
    ]);
  });

  it("fails closed on excessive alias expansion", () => {
    const aliases = (anchor: string): string =>
      Array.from({ length: 11 }, () => `*${anchor}`).join(", ");
    const content = [
      "a: &a [value]",
      `b: &b [${aliases("a")}]`,
      `c: &c [${aliases("b")}]`,
      `d: [${aliases("c")}]`,
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([
      expect.objectContaining({
        kind: "invalid-yaml",
        line: 1,
        detail: expect.stringContaining("resource exhaustion"),
      }),
    ]);
  });

  it("returns no findings for a clean document", () => {
    expect(findWorkflowPinViolations("name: example\njobs: {}\n")).toEqual([]);
  });
});

describe("live audited manifests (issue #102)", () => {
  const auditedFiles = listFilesRecursively(GITHUB_DIR).filter((path) =>
    isWorkflowPinAuditManifestPath(repositoryRelativePath(path)),
  );

  it("discovers at least one real manifest and audits each structurally", () => {
    expect(auditedFiles.length).toBeGreaterThan(0);

    const failures = auditedFiles.flatMap((path) =>
      findWorkflowPinViolations(
        readFileSync(path, "utf8"),
        REPOSITORY_ROOT,
      ).map(
        (violation) =>
          `${repositoryRelativePath(path)}:${violation.line} -- ${violation.detail}`,
      ),
    );
    expect(failures).toEqual([]);
  });

  it("discovers every workflow YAML and any composite action manifest", () => {
    const workflowFiles = listFilesRecursively(WORKFLOWS_DIR).filter((path) =>
      /\.ya?ml$/i.test(path),
    );
    const actionFiles = existsSync(ACTIONS_DIR)
      ? listFilesRecursively(ACTIONS_DIR).filter((path) =>
          /^action\.ya?ml$/i.test(basename(path)),
        )
      : [];
    const expected = [...workflowFiles, ...actionFiles]
      .map(repositoryRelativePath)
      .sort();
    expect(auditedFiles.map(repositoryRelativePath).sort()).toEqual(expected);
  });

  it("finds at least one real pinned Claude action invocation", () => {
    const actionUseFiles = auditedFiles
      .filter((path) =>
        manifestUsesPinnedClaudeAction(
          repositoryRelativePath(path),
          readFileSync(path, "utf8"),
        ),
      )
      .map(repositoryRelativePath);
    expect(actionUseFiles.length).toBeGreaterThan(0);
  });

  it("covers the live IMPLEMENT_AGENT_ACTION_REF provenance scalar", () => {
    const implementWorkflow = auditedFiles.find((path) =>
      path.endsWith("/implement-ready-issues.yml"),
    );
    expect(implementWorkflow).toBeDefined();
    const content = readFileSync(implementWorkflow!, "utf8");
    expect(content).toContain("IMPLEMENT_AGENT_ACTION_REF");
    expect(content).toMatch(
      new RegExp(
        `^\\s*IMPLEMENT_AGENT_ACTION_REF:\\s*["']anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}["']\\s*(?:#.*)?$`,
        "m",
      ),
    );
  });
});
