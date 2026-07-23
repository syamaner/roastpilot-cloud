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
  const reviewSteps = findNamedSteps(steps, "Run Claude Code Review");
  const cleanupStep = cleanupSteps[0];
  const marketplaceStep = marketplaceSteps[0];
  const reviewStep = reviewSteps[0];
  const marketplaceWith = asMapping(marketplaceStep?.with);
  const reviewWith = asMapping(reviewStep?.with);
  const failures: string[] = [];

  if (
    cleanupSteps.length !== 1 ||
    marketplaceSteps.length !== 1 ||
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
    hasExecutionOverride(reviewStep)
  ) {
    failures.push("marketplace setup and review steps must always execute");
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
  if (reviewWith?.plugins !== "code-review@claude-code-plugins") {
    failures.push("Claude review must load the reviewed code-review plugin");
  }
  if (
    steps.indexOf(cleanupStep) < 0 ||
    steps.indexOf(marketplaceStep) !== steps.indexOf(cleanupStep) + 1 ||
    steps.indexOf(reviewStep) !== steps.indexOf(marketplaceStep) + 1
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

  it.each(["if: false", "continue-on-error: true"])(
    "rejects a checkout with the execution override %s",
    (override) => {
      const mutatedWorkflow = WORKFLOW_CONTENT.replace(
        "      - name: Checkout Claude Code plugin marketplace\n",
        [
          "      - name: Checkout Claude Code plugin marketplace",
          `        ${override}`,
          "",
        ].join("\n"),
      );
      expect(validateMarketplacePin(mutatedWorkflow)).toContain(
        "marketplace setup and review steps must always execute",
      );
    },
  );

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
