import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_DERIVED_FIELDS } from "../../scripts/factory/eval/expected-result-schema.mts";
import { MANIFEST_CASE_ALLOWED_KEYS } from "../../scripts/factory/eval/corpus-manifest-schema.mts";
import { loadCorpus } from "../../scripts/factory/eval/corpus-loader.mts";

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
    if (!result.ok) expect(result.errors.join(" ")).toContain("outside corpus root");
  });
});
