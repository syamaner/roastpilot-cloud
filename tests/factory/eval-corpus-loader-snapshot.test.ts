import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCorpusSnapshot,
} from "../../scripts/factory/eval/corpus-loader.mts";
import {
  assembleCorpus,
  MAX_DECISION_CONTEXT_BYTES,
} from "../../scripts/factory/eval/corpus-loader-logic.mts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "readFile");
      return handle;
    }),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});

const CORPUS_ROOT = fileURLToPath(new URL("../../eval/corpus/", import.meta.url));
const CORPUS_PREFIX = "eval/corpus/";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })),
  );
});

describe("immutable corpus snapshot", () => {
  it("T189 reads every corpus file and directory exactly once", async () => {
    const entries = await readdir(CORPUS_ROOT, {
      recursive: true,
      withFileTypes: true,
    });
    const expectedFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name))
      .sort();
    const expectedDirectories = [
      resolve(CORPUS_ROOT),
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(entry.parentPath, entry.name)),
    ].sort();
    vi.clearAllMocks();

    const snapshot = await loadCorpusSnapshot(CORPUS_ROOT, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(true);
    expect(vi.mocked(readdir).mock.calls.map(([path]) => String(path)).sort()).toEqual(
      expectedDirectories,
    );
    expect(vi.mocked(open).mock.calls.map(([path]) => String(path)).sort()).toEqual(
      expectedFiles,
    );
    expect(readFile).not.toHaveBeenCalled();
    const handles = await Promise.all(
      vi.mocked(open).mock.results.map(async (result) => result.value),
    );
    expect(handles).toHaveLength(expectedFiles.length);
    for (const handle of handles) {
      expect(handle.readFile).toHaveBeenCalledTimes(1);
    }
  });

  it("T190 keeps manifest, documentation, inputs, and expectations in hash coverage", async () => {
    const snapshot = await loadCorpusSnapshot(CORPUS_ROOT, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.errors.join("\n"));
    const paths = snapshot.hashInput.map((entry) => entry.relativePath);
    expect(paths).toContain("eval/corpus/manifest.json");
    expect(paths).toContain("eval/corpus/README.md");
    expect(paths.some((path) => path.startsWith("eval/corpus/inputs/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("eval/corpus/expectations/"))).toBe(true);
    expect(paths.every((path) => path.startsWith(CORPUS_PREFIX))).toBe(true);
  });

  it("T191 fails closed without hash input for a symlink entry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "corpus-snapshot-link-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "corpus");
    await mkdir(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(join(parent, "outside.txt"), "outside");
    await symlink(join(parent, "outside.txt"), join(root, "linked.txt"));
    const snapshot = await loadCorpusSnapshot(root, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(false);
    expect(snapshot).not.toHaveProperty("hashInput");
    if (!snapshot.ok) expect(snapshot.errors.join(" ")).toContain("linked.txt is a symlink");
  });

  it("T192 fails closed without hash input for an oversized file", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-snapshot-oversized-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(
      join(root, "README.md"),
      "x".repeat(MAX_DECISION_CONTEXT_BYTES + 1),
    );
    const snapshot = await loadCorpusSnapshot(root, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(false);
    expect(snapshot).not.toHaveProperty("hashInput");
    if (!snapshot.ok) {
      expect(snapshot.errors).toContain(
        `README.md exceeds ${String(MAX_DECISION_CONTEXT_BYTES)} bytes`,
      );
    }
  });

  it("T193 fails closed without hash input for non-UTF-8 bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-snapshot-utf8-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    await writeFile(join(root, "README.md"), Uint8Array.from([0xff]));
    const snapshot = await loadCorpusSnapshot(root, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(false);
    expect(snapshot).not.toHaveProperty("hashInput");
    if (!snapshot.ok) {
      expect(snapshot.errors).toContain("README.md is not valid UTF-8");
    }
  });

  it("T194 assembles the same fatal-UTF-8 text carried by every hash buffer", async () => {
    const snapshot = await loadCorpusSnapshot(CORPUS_ROOT, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.errors.join("\n"));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const textFiles = new Map(
      snapshot.hashInput.map((entry) => [
        entry.relativePath.slice(CORPUS_PREFIX.length),
        decoder.decode(entry.bytes),
      ]),
    );
    expect(textFiles.size).toBe(snapshot.hashInput.length);
    const manifestText = textFiles.get("manifest.json");
    expect(manifestText).toBeDefined();
    textFiles.delete("manifest.json");
    const reassembled = assembleCorpus(manifestText!, textFiles);
    expect(reassembled.ok).toBe(true);
    if (reassembled.ok) expect(reassembled.value).toEqual(snapshot.value);
  });

  it("T199 fails closed without a partial snapshot when assembly rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-snapshot-assembly-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "manifest.json"), '{"schemaVersion":1}');
    const snapshot = await loadCorpusSnapshot(root, CORPUS_PREFIX);
    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) expect(snapshot.errors.length).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty("value");
    expect(snapshot).not.toHaveProperty("hashInput");
  });
});
