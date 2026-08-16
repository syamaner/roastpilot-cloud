import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_DERIVED_FIELDS } from "../../scripts/factory/eval/expected-result-schema.mts";
import { MANIFEST_CASE_ALLOWED_KEYS } from "../../scripts/factory/eval/corpus-manifest-schema.mts";
import { loadCorpus } from "../../scripts/factory/eval/corpus-loader.mts";
import { MAX_DECISION_CONTEXT_BYTES } from "../../scripts/factory/eval/corpus-loader-logic.mts";

const CORPUS_ROOT = fileURLToPath(new URL("../../eval/corpus/", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("corpus isolation contract", () => {
  it("T55 loads the committed corpus", async () => {
    expect((await loadCorpus(CORPUS_ROOT)).ok).toBe(true);
  });

  it("T56 keeps producer and scorer partitions isolated", async () => {
    const result = await loadCorpus(CORPUS_ROOT); expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.producerVisiblePaths].some((path) => path.startsWith("expectations/"))).toBe(false);
      expect(result.value.cases.flatMap((entry) => [...entry.triageProducerInputs]).some((path) => path.includes("/recorded/"))).toBe(false);
      expect([...result.value.producerVisiblePaths].some((path) => result.value.scorerVisiblePaths.has(path))).toBe(false);
      expect(result.value.producerVisiblePaths.has("README.md")).toBe(false);
      expect(result.value.scorerVisiblePaths.has("README.md")).toBe(false);
    }
  });

  it("T57 keeps manifest producer keys disjoint from answer-derived fields", () => {
    expect(ANSWER_DERIVED_FIELDS.filter((key) => MANIFEST_CASE_ALLOWED_KEYS.has(key))).toEqual([]);
  });

  it("T58 pins every live manifest case to the closed producer schema", async () => {
    const result = await loadCorpus(CORPUS_ROOT); expect(result.ok).toBe(true);
    if (result.ok) for (const corpusCase of result.value.manifest.cases) {
      expect(Object.keys(corpusCase).every((key) => MANIFEST_CASE_ALLOWED_KEYS.has(key))).toBe(true);
    }
  });

  it("T59 pins the live census", async () => {
    const result = await loadCorpus(CORPUS_ROOT); expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cases).toHaveLength(12);
      expect(result.value.cases.filter((entry) => entry.expected.implement !== null)).toHaveLength(4);
    }
  });

  it("T60 rejects a symlink escape without reading outside", async () => {
    const parent = await mkdtemp(join(tmpdir(), "corpus-isolation-")); temporaryDirectories.push(parent);
    const root = join(parent, "corpus"); const outside = join(parent, "outside.txt");
    await mkdir(root); await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(outside, "secret"); await symlink(outside, join(root, "escape.txt"));
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("escape.txt is a symlink");
  });

  it("rejects a corpus root that cannot be resolved", async () => {
    const parent = await mkdtemp(join(tmpdir(), "corpus-missing-root-")); temporaryDirectories.push(parent);
    const result = await loadCorpus(join(parent, "missing"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("cannot be resolved");
  });

  it("rejects a symlinked corpus root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "corpus-root-link-")); temporaryDirectories.push(parent);
    const target = join(parent, "corpus"); const root = join(parent, "corpus-link");
    await mkdir(target); await writeFile(join(target, "manifest.json"), '{"schemaVersion":1}');
    await symlink(target, root);
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(`corpus root ${root} is a symlink`);
  });

  it("rejects a regular file supplied as the corpus root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "corpus-file-root-")); temporaryDirectories.push(parent);
    const root = join(parent, "corpus.txt"); await writeFile(root, "not a directory");
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("cannot be enumerated");
  });

  it("rejects a broken symlink entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-broken-link-")); temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await symlink(join(root, "missing.txt"), join(root, "broken.txt"));
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("broken.txt is a symlink");
  });

  it("rejects an in-root producer path symlinked to scorer-only content", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-answer-alias-")); temporaryDirectories.push(root);
    await cp(CORPUS_ROOT, root, { recursive: true });
    const caseId = "issue-023-dryrun-second";
    const verdictPath = join(root, "inputs", caseId, "recorded", "triage-verdict.json");
    const expectedPath = join(root, "expectations", caseId, "expected.json");
    await rm(verdictPath);
    await symlink(expectedPath, verdictPath);
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("triage-verdict.json is a symlink");
  });

  it("rejects an IO corpus with no manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-no-manifest-")); temporaryDirectories.push(root);
    await writeFile(join(root, "README.md"), "documentation");
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("manifest.json is missing");
  });

  it("rejects an oversized regular file before assembly", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-oversized-")); temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(join(root, "README.md"), "x".repeat(MAX_DECISION_CONTEXT_BYTES + 1));
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain(`README.md exceeds ${String(MAX_DECISION_CONTEXT_BYTES)} bytes`);
  });

  it("rejects malformed UTF-8 without replacement decoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-invalid-utf8-")); temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(join(root, "README.md"), Uint8Array.from([0xff]));
    const result = await loadCorpus(root); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("README.md is not valid UTF-8");
  });
});
