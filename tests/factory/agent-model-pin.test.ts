import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AGENTS_DIRECTORY = join(REPOSITORY_ROOT, ".claude", "agents");

/**
 * Every sub-agent definition must pin its model explicitly. An agent with no
 * `model:` INHERITS THE PARENT, so an unpinned definition spawned from an Opus
 * main loop silently runs Opus across a whole fan-out — the cost failure this
 * test exists to make impossible rather than merely documented.
 */
const ALLOWED_MODELS = new Set(["fable", "opus", "sonnet"]);

/**
 * `fable` is admitted for exactly one role, the `story-planner` spec tier
 * (topology v2, issue #159). The validator itself rejects a fable pin on any
 * other definition — a describe-block assertion on the planner alone would
 * pin story-planner → fable but not fable → story-planner, leaving every
 * other agent free to adopt the tier silently.
 */
const FABLE_ONLY_AGENT = "story-planner";

/**
 * The adversarial security lenses stay on Opus (operator, 27 Jul 2026). A
 * missed pipeline-security or grant-boundary defect is the expensive failure,
 * so these two may not be quietly downgraded to save budget.
 */
const REQUIRED_OPUS_AGENTS = new Set([
  "factory-security-reviewer",
  "schema-migration-reviewer",
]);

interface AgentFile {
  readonly fileName: string;
  readonly content: string;
}

function readAgentFiles(): AgentFile[] {
  // Recursive, so a definition hidden in a subdirectory reaches the validator
  // (which rejects nesting outright) instead of being silently skipped.
  return readdirSync(AGENTS_DIRECTORY, { recursive: true })
    .map((entry) => entry.toString())
    .filter((fileName) => fileName.endsWith(".md"))
    .sort()
    .map((fileName) => ({
      fileName,
      content: readFileSync(join(AGENTS_DIRECTORY, fileName), "utf8"),
    }));
}

function parseFrontMatter(content: string): Record<string, unknown> | undefined {
  // Deliberately strict: the delimiters must be the first line and a later
  // line, both exactly `---`. A definition whose front matter does not parse
  // fails closed rather than being skipped.
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return undefined;
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    return undefined;
  }
  const parsed: unknown = parse(lines.slice(1, closingIndex).join("\n"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * Validates the sub-agent roster.
 *
 * @param files - Agent definition files, as read from `.claude/agents`.
 * @returns One message per violation; empty when the roster is valid.
 */
export function validateAgentModelPins(files: AgentFile[]): string[] {
  const failures: string[] = [];

  // A glob that matches nothing must not pass vacuously — an empty roster is
  // itself a failure, because it would silently disable this gate.
  if (files.length === 0) {
    failures.push("agent roster must not be empty");
  }

  for (const { fileName, content } of files) {
    if (fileName.includes("/") || fileName.includes("\\")) {
      failures.push(
        `${fileName}: agent definitions must live at the roster's top level`,
      );
      continue;
    }
    const frontMatter = parseFrontMatter(content);
    if (frontMatter === undefined) {
      failures.push(`${fileName}: front matter must parse as a YAML mapping`);
      continue;
    }

    const name = frontMatter.name;
    const model = frontMatter.model;

    if (typeof name !== "string" || name !== fileName.replace(/\.md$/, "")) {
      failures.push(`${fileName}: name must match the file name`);
    }
    if (typeof model !== "string") {
      failures.push(`${fileName}: model must be pinned explicitly`);
      continue;
    }
    if (!ALLOWED_MODELS.has(model)) {
      failures.push(
        `${fileName}: model must be one of ${[...ALLOWED_MODELS].sort().join(", ")}`,
      );
    }
    if (model === "fable" && name !== FABLE_ONLY_AGENT) {
      failures.push(`${fileName}: fable is role-scoped to ${FABLE_ONLY_AGENT}`);
    }
    if (typeof name === "string" && REQUIRED_OPUS_AGENTS.has(name) && model !== "opus") {
      failures.push(`${fileName}: adversarial security reviewers must stay on opus`);
    }
  }

  for (const required of [...REQUIRED_OPUS_AGENTS].sort()) {
    if (!files.some(({ fileName }) => fileName === `${required}.md`)) {
      failures.push(`${required}.md: required adversarial reviewer is missing`);
    }
  }

  return failures;
}

describe("sub-agent model pins (issue #148)", () => {
  it("pins every agent in the live roster", () => {
    expect(validateAgentModelPins(readAgentFiles())).toEqual([]);
  });

  it("includes the independent triage role, so the author never self-triages", () => {
    const triage = readAgentFiles().find(
      ({ fileName }) => fileName === "pr-triage.md",
    );
    expect(triage).toBeDefined();
    expect(parseFrontMatter(triage!.content)?.model).toBe("sonnet");
  });

  it("pins the story planner to fable, so the spec tier cannot silently downgrade (issue #159)", () => {
    const planner = readAgentFiles().find(
      ({ fileName }) => fileName === "story-planner.md",
    );
    expect(planner).toBeDefined();
    expect(parseFrontMatter(planner!.content)?.model).toBe("fable");
  });

  it("pins the implementer to opus (issue #159)", () => {
    const implementer = readAgentFiles().find(
      ({ fileName }) => fileName === "implementer.md",
    );
    expect(implementer).toBeDefined();
    expect(parseFrontMatter(implementer!.content)?.model).toBe("opus");
  });

  it.each([
    [
      "an unpinned agent",
      "---\nname: example\ntools: Read\n---\n",
      "model must be pinned explicitly",
    ],
    [
      "a model outside the allowed set",
      "---\nname: example\nmodel: gpt-4\n---\n",
      "model must be one of",
    ],
    [
      "a name that does not match its file",
      "---\nname: mismatched\nmodel: sonnet\n---\n",
      "name must match the file name",
    ],
    [
      "a fable pin outside the planner role",
      "---\nname: example\nmodel: fable\n---\n",
      "fable is role-scoped to story-planner",
    ],
    [
      "front matter that is not a mapping",
      "---\n- not-a-mapping\n---\n",
      "front matter must parse as a YAML mapping",
    ],
    [
      "a definition with no front matter at all",
      "# just a heading\n",
      "front matter must parse as a YAML mapping",
    ],
    [
      "front matter whose delimiter is never closed",
      "---\nname: example\nmodel: sonnet\n",
      "front matter must parse as a YAML mapping",
    ],
  ])("rejects %s", (_case, content, expectedFailure) => {
    expect(
      validateAgentModelPins([{ fileName: "example.md", content }]),
    ).toContainEqual(expect.stringContaining(expectedFailure));
  });

  it("rejects widening fable beyond the planner role, on the live roster", () => {
    const widened = readAgentFiles().map(({ fileName, content }) =>
      fileName === "qa.md"
        ? { fileName, content: content.replace("model: sonnet", "model: fable") }
        : { fileName, content },
    );
    expect(validateAgentModelPins(widened)).toContainEqual(
      expect.stringContaining("fable is role-scoped to story-planner"),
    );
  });

  it("rejects a nested agent definition rather than skipping it", () => {
    expect(
      validateAgentModelPins([
        {
          fileName: "nested/sneaky.md",
          content: "---\nname: sneaky\nmodel: sonnet\n---\n",
        },
      ]),
    ).toContainEqual(expect.stringContaining("roster's top level"));
  });

  it("rejects downgrading an adversarial security reviewer to sonnet", () => {
    const downgraded = readAgentFiles().map(({ fileName, content }) =>
      fileName === "factory-security-reviewer.md"
        ? { fileName, content: content.replace("model: opus", "model: sonnet") }
        : { fileName, content },
    );
    expect(validateAgentModelPins(downgraded)).toContainEqual(
      expect.stringContaining("adversarial security reviewers must stay on opus"),
    );
  });

  it("rejects removing a required adversarial reviewer", () => {
    const withoutReviewer = readAgentFiles().filter(
      ({ fileName }) => fileName !== "schema-migration-reviewer.md",
    );
    expect(validateAgentModelPins(withoutReviewer)).toContainEqual(
      expect.stringContaining("required adversarial reviewer is missing"),
    );
  });

  it("rejects an empty roster rather than passing vacuously", () => {
    expect(validateAgentModelPins([])).toContain("agent roster must not be empty");
  });
});
