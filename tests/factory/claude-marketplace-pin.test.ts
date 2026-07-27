import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "claude-code-review.yml",
);
const WORKFLOW_CONTENT = readFileSync(WORKFLOW_PATH, "utf8");
const CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const MARKETPLACE_REPOSITORY = "anthropics/claude-code";
const MARKETPLACE_SHA = "2982f951552e94f38cd972764ae94c1d90c41da3";
const MARKETPLACE_PATH = ".claude-marketplace";
// Claude Code reserves `claude-code-plugins` for official Anthropic
// marketplaces added from an `anthropics` GitHub source, so the immutable
// local checkout must be renamed before it can be added by path.
const RESERVED_MARKETPLACE_NAME = "claude-code-plugins";
const LOCAL_MARKETPLACE_NAME = "roastpilot-pinned-plugins";
const MANIFEST_SHA256 =
  "663c1abf7f7661453bd5ce2b1ddcd2827b6ef7cad1b0b11f648c9ea08273c6e5";
const RENAME_STEP_NAME = "Rename pinned marketplace to a non-reserved name";
// The exact rewrite, asserted verbatim: the step also greps for the new
// name afterwards, so a looser substring check would still pass if the
// rewrite itself were retargeted.
const RENAME_COMMAND =
  `sed -i 's/^  "name": "${RESERVED_MARKETPLACE_NAME}",$/` +
  `  "name": "${LOCAL_MARKETPLACE_NAME}",/'`;

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

function findNamedSteps(steps: unknown[], name: string): Mapping[] {
  return steps
    .map(asMapping)
    .filter((step): step is Mapping => step?.name === name);
}

function hasExecutionOverride(step: Mapping | undefined): boolean {
  return (
    step !== undefined &&
    (Object.prototype.hasOwnProperty.call(step, "if") ||
      Object.prototype.hasOwnProperty.call(step, "continue-on-error"))
  );
}

function validateMarketplacePin(workflow: string): string[] {
  const document = parseDocument(workflow);
  if (document.errors.length > 0) {
    return ["workflow must be valid YAML"];
  }

  const root = asMapping(document.toJS({ maxAliasCount: 100 }));
  const jobs = asMapping(root?.jobs);
  const reviewJob = asMapping(jobs?.["claude-review"]);
  const steps = Array.isArray(reviewJob?.steps) ? reviewJob.steps : [];
  const cleanupSteps = findNamedSteps(
    steps,
    "Clear Claude Code plugin marketplace path",
  );
  const marketplaceSteps = findNamedSteps(
    steps,
    "Checkout Claude Code plugin marketplace",
  );
  const renameSteps = findNamedSteps(steps, RENAME_STEP_NAME);
  const reviewSteps = findNamedSteps(steps, "Run Claude Code Review");
  const cleanupStep = cleanupSteps[0];
  const marketplaceStep = marketplaceSteps[0];
  const renameStep = renameSteps[0];
  const reviewStep = reviewSteps[0];
  const marketplaceWith = asMapping(marketplaceStep?.with);
  const reviewWith = asMapping(reviewStep?.with);
  const failures: string[] = [];

  if (
    cleanupSteps.length !== 1 ||
    marketplaceSteps.length !== 1 ||
    renameSteps.length !== 1 ||
    reviewSteps.length !== 1
  ) {
    failures.push("cleanup, marketplace checkout, and review steps must be unique");
  }
  if (
    cleanupStep?.shell !== "bash" ||
    typeof cleanupStep.run !== "string" ||
    cleanupStep.run.trim() !==
      'rm -rf -- "${GITHUB_WORKSPACE:?}/.claude-marketplace"'
  ) {
    failures.push("marketplace path must be safely cleared before checkout");
  }
  if (
    hasExecutionOverride(cleanupStep) ||
    hasExecutionOverride(marketplaceStep) ||
    hasExecutionOverride(renameStep) ||
    hasExecutionOverride(reviewStep)
  ) {
    failures.push("marketplace setup and review steps must always execute");
  }
  const renameRun =
    typeof renameStep?.run === "string" ? renameStep.run : undefined;
  if (renameStep?.shell !== "bash" || renameRun === undefined) {
    failures.push("marketplace rename must be an explicit bash step");
  }
  if (renameRun !== undefined && !renameRun.includes(MANIFEST_SHA256)) {
    failures.push(
      "marketplace rename must verify the source-reviewed manifest hash",
    );
  }
  if (renameRun !== undefined && !renameRun.includes(RENAME_COMMAND)) {
    failures.push("marketplace rename must apply the non-reserved local name");
  }
  if (marketplaceStep?.uses !== CHECKOUT_ACTION) {
    failures.push("marketplace checkout must use the pinned checkout action");
  }
  if (marketplaceWith?.repository !== MARKETPLACE_REPOSITORY) {
    failures.push("marketplace checkout must use anthropics/claude-code");
  }
  if (
    typeof marketplaceWith?.ref !== "string" ||
    !/^[0-9a-f]{40}$/.test(marketplaceWith.ref) ||
    marketplaceWith.ref !== MARKETPLACE_SHA
  ) {
    failures.push("marketplace checkout must use the source-reviewed full SHA");
  }
  if (marketplaceWith?.path !== MARKETPLACE_PATH) {
    failures.push("marketplace checkout must use the fixed local path");
  }
  if (marketplaceWith?.["fetch-depth"] !== 1) {
    failures.push("marketplace checkout must be shallow");
  }
  if (marketplaceWith?.["persist-credentials"] !== false) {
    failures.push("marketplace checkout must not persist credentials");
  }
  if (reviewWith?.plugin_marketplaces !== `./${MARKETPLACE_PATH}`) {
    failures.push("Claude review must load only the local marketplace");
  }
  if (reviewWith?.plugins !== `code-review@${LOCAL_MARKETPLACE_NAME}`) {
    failures.push("Claude review must load the reviewed code-review plugin");
  }
  if (
    typeof reviewWith?.plugins === "string" &&
    reviewWith.plugins.includes(RESERVED_MARKETPLACE_NAME)
  ) {
    failures.push(
      "Claude review must not reference the reserved marketplace name",
    );
  }
  if (
    steps.indexOf(cleanupStep) < 0 ||
    steps.indexOf(marketplaceStep) !== steps.indexOf(cleanupStep) + 1 ||
    steps.indexOf(renameStep) !== steps.indexOf(marketplaceStep) + 1 ||
    steps.indexOf(reviewStep) !== steps.indexOf(renameStep) + 1
  ) {
    failures.push("cleanup, marketplace checkout, and review must be adjacent");
  }

  return failures;
}

describe("Claude code-review marketplace pin (issue #41)", () => {
  it("loads the reviewed marketplace commit from a hardened local checkout", () => {
    expect(validateMarketplacePin(WORKFLOW_CONTENT)).toEqual([]);
  });

  it.each([
    [
      "floating ref",
      `ref: ${MARKETPLACE_SHA}`,
      "ref: main",
      "source-reviewed full SHA",
    ],
    [
      "malformed ref",
      `ref: ${MARKETPLACE_SHA}`,
      "ref: 2982f951",
      "source-reviewed full SHA",
    ],
    [
      "wrong repository",
      `repository: ${MARKETPLACE_REPOSITORY}`,
      "repository: attacker/claude-code",
      "anthropics/claude-code",
    ],
    [
      "wrong local path",
      `path: ${MARKETPLACE_PATH}`,
      "path: .mutable-marketplace",
      "fixed local path",
    ],
    [
      "remote marketplace input",
      `plugin_marketplaces: './${MARKETPLACE_PATH}'`,
      "plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'",
      "load only the local marketplace",
    ],
    [
      "reserved marketplace name in the plugin reference",
      `plugins: 'code-review@${LOCAL_MARKETPLACE_NAME}'`,
      `plugins: 'code-review@${RESERVED_MARKETPLACE_NAME}'`,
      "reviewed code-review plugin",
    ],
    [
      "rename that skips the manifest hash gate",
      `expected_sha256='${MANIFEST_SHA256}'`,
      "expected_sha256=\"$(sha256sum -- \"$manifest\" | cut -d' ' -f1)\"",
      "source-reviewed manifest hash",
    ],
    [
      "rename to a different name than the review step loads",
      RENAME_COMMAND,
      `sed -i 's/^  "name": "${RESERVED_MARKETPLACE_NAME}",$/` +
        `  "name": "attacker-marketplace",/'`,
      "non-reserved local name",
    ],
    [
      "missing credential hardening",
      [
        `          path: ${MARKETPLACE_PATH}`,
        "          fetch-depth: 1",
        "          persist-credentials: false",
      ].join("\n"),
      [
        `          path: ${MARKETPLACE_PATH}`,
        "          fetch-depth: 1",
      ].join("\n"),
      "must not persist credentials",
    ],
  ])(
    "rejects a %s",
    (_name, currentValue, unsafeValue, expectedFailure) => {
      const mutatedWorkflow = WORKFLOW_CONTENT.replace(
        currentValue,
        unsafeValue,
      );
      expect(mutatedWorkflow).not.toBe(WORKFLOW_CONTENT);
      expect(validateMarketplacePin(mutatedWorkflow)).toContainEqual(
        expect.stringContaining(expectedFailure),
      );
    },
  );

  it.each([
    ["Checkout Claude Code plugin marketplace", "if: false"],
    ["Checkout Claude Code plugin marketplace", "continue-on-error: true"],
    [RENAME_STEP_NAME, "if: false"],
    [RENAME_STEP_NAME, "continue-on-error: true"],
  ])("rejects %s with the execution override %s", (stepName, override) => {
    const mutatedWorkflow = WORKFLOW_CONTENT.replace(
      `      - name: ${stepName}\n`,
      [`      - name: ${stepName}`, `        ${override}`, ""].join("\n"),
    );
    expect(mutatedWorkflow).not.toBe(WORKFLOW_CONTENT);
    expect(validateMarketplacePin(mutatedWorkflow)).toContain(
      "marketplace setup and review steps must always execute",
    );
  });

  it("rejects a workflow with the rename step removed entirely", () => {
    const renameBlockStart = WORKFLOW_CONTENT.indexOf(
      `      - name: ${RENAME_STEP_NAME}`,
    );
    const reviewBlockStart = WORKFLOW_CONTENT.indexOf(
      "      - name: Run Claude Code Review",
    );
    expect(renameBlockStart).toBeGreaterThan(-1);
    expect(reviewBlockStart).toBeGreaterThan(renameBlockStart);
    const mutatedWorkflow =
      WORKFLOW_CONTENT.slice(0, renameBlockStart) +
      WORKFLOW_CONTENT.slice(reviewBlockStart);
    expect(validateMarketplacePin(mutatedWorkflow)).toContainEqual(
      expect.stringContaining("must be unique"),
    );
  });

  it("rejects an intervening step that can overwrite the local marketplace", () => {
    const mutatedWorkflow = WORKFLOW_CONTENT.replace(
      "\n\n      - name: Run Claude Code Review",
      [
        "",
        "",
        "      - name: Replace marketplace",
        "        run: cp -R attacker .claude-marketplace",
        "",
        "      - name: Run Claude Code Review",
      ].join("\n"),
    );
    expect(validateMarketplacePin(mutatedWorkflow)).toContain(
      "cleanup, marketplace checkout, and review must be adjacent",
    );
  });

  it("rejects a safe-looking duplicate checkout step", () => {
    const marketplaceBlock = [
      "      - name: Checkout Claude Code plugin marketplace",
      `        uses: ${CHECKOUT_ACTION}`,
      "        with:",
      `          repository: ${MARKETPLACE_REPOSITORY}`,
      `          ref: ${MARKETPLACE_SHA}`,
      `          path: ${MARKETPLACE_PATH}`,
      "          fetch-depth: 1",
      "          persist-credentials: false",
      "",
    ].join("\n");
    const mutatedWorkflow = WORKFLOW_CONTENT.replace(
      "      - name: Run Claude Code Review",
      `${marketplaceBlock}\n      - name: Run Claude Code Review`,
    );
    expect(validateMarketplacePin(mutatedWorkflow)).toContain(
      "cleanup, marketplace checkout, and review steps must be unique",
    );
  });
});
