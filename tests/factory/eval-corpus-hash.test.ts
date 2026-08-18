import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpusSnapshot } from "../../scripts/factory/eval/corpus-loader.mts";
import {
  computeCorpusSha256,
  enumerateCorpusFiles,
  type CorpusFileInput,
} from "../../scripts/factory/eval/eval-corpus-hash.mts";

const encoder = new TextEncoder();

function file(relativePath: string, content: string): CorpusFileInput {
  return { relativePath, bytes: encoder.encode(content) };
}

function manualDigest(files: readonly CorpusFileInput[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const entry of sorted) {
    hash.update(
      `${entry.relativePath}\0${String(entry.bytes.byteLength)}\0`,
      "utf8",
    );
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

describe("full corpus SHA-256", () => {
  it("T188 snapshot hashing is byte-identical to the independent corpus oracle", async () => {
    const root = fileURLToPath(new URL("../../eval/corpus/", import.meta.url));
    const snapshot = await loadCorpusSnapshot(root, "eval/corpus/");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.errors.join("\n"));
    const enumerated = await enumerateCorpusFiles(root, "eval/corpus/");
    expect(snapshot.hashInput.map((entry) => entry.relativePath).sort()).toEqual(
      enumerated.map((entry) => entry.relativePath).sort(),
    );
    expect(computeCorpusSha256(snapshot.hashInput)).toBe(
      computeCorpusSha256(enumerated),
    );
  });

  it("T170 is deterministic and emits lowercase 64-hex", () => {
    const files = [
      file("eval/corpus/manifest.json", "manifest"),
      file("eval/corpus/inputs/.fixture", "input"),
    ];
    const first = computeCorpusSha256(files);
    expect(computeCorpusSha256(files)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T171 sorts internally so caller order cannot change the digest", () => {
    const sorted = [file("a", "one"), file("b", "two"), file("c", "three")];
    expect(computeCorpusSha256([...sorted].reverse())).toBe(
      computeCorpusSha256(sorted),
    );
    expect(computeCorpusSha256([sorted[1]!, sorted[2]!, sorted[0]!])).toBe(
      computeCorpusSha256(sorted),
    );
  });

  it("T172 changes the digest when one content byte changes", () => {
    const original = [file("eval/corpus/a", "abc")];
    const changed = [
      { relativePath: original[0]!.relativePath, bytes: new Uint8Array([97, 98, 100]) },
    ];
    expect(computeCorpusSha256(changed)).not.toBe(computeCorpusSha256(original));
  });

  it("T173 binds additions, removals, and byte-identical renames into the digest", () => {
    const original = [
      file("a", "left"),
      file("m", "same"),
      file("z", "right"),
    ];
    const originalDigest = computeCorpusSha256(original);
    expect(computeCorpusSha256([...original, file("zz", "added")])).not.toBe(
      originalDigest,
    );
    expect(computeCorpusSha256(original.slice(0, 2))).not.toBe(originalDigest);
    const samePositionRename = [original[0]!, file("n", "same"), original[2]!];
    expect(computeCorpusSha256(samePositionRename)).not.toBe(originalDigest);
  });

  it("T174 uses NUL and byte-length framing to separate concatenation collisions", () => {
    expect(computeCorpusSha256([file("a", "bc")])).not.toBe(
      computeCorpusSha256([file("ab", "c")]),
    );
    const firstPartition = [file("a", "b"), file("cd", "e")];
    const secondPartition = [file("ab", "c"), file("d", "e")];
    expect(
      firstPartition.map((entry) => `${entry.relativePath}${new TextDecoder().decode(entry.bytes)}`).join(""),
    ).toBe(
      secondPartition.map((entry) => `${entry.relativePath}${new TextDecoder().decode(entry.bytes)}`).join(""),
    );
    expect(computeCorpusSha256(firstPartition)).not.toBe(
      computeCorpusSha256(secondPartition),
    );
  });

  it("T175 rejects empty, duplicate, and non-canonical path inputs", () => {
    expect(() => computeCorpusSha256([])).toThrow();
    expect(() => computeCorpusSha256([file("a", "1"), file("a", "2")])).toThrow();
    for (const relativePath of [
      "",
      "../a",
      "a/../b",
      "/a",
      "a/",
      "a//b",
      "a\\b",
      "a:b",
      "a/./b",
    ]) {
      expect(() => computeCorpusSha256([file(relativePath, "x")])).toThrow();
    }
  });

  it("T176 enumerates nested files and dotfiles while excluding a sibling baseline tree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "roastpilot-corpus-hash-"));
    try {
      const root = join(parent, "corpus");
      const baseline = join(parent, "baseline");
      await mkdir(join(root, "inputs", "case"), { recursive: true });
      await mkdir(baseline);
      await writeFile(join(root, "manifest.json"), "manifest");
      await writeFile(join(root, ".dotfile"), "dot");
      await writeFile(join(root, "inputs", "case", "issue.json"), "issue");
      await writeFile(join(baseline, "recorded-baseline.json"), "excluded");

      const enumerated = await enumerateCorpusFiles(root, "eval/corpus/");
      const paths = enumerated.map((entry) => entry.relativePath).sort();
      expect(paths).toEqual([
        "eval/corpus/.dotfile",
        "eval/corpus/inputs/case/issue.json",
        "eval/corpus/manifest.json",
      ]);
      expect(paths.every((relativePath) => relativePath.startsWith("eval/corpus/"))).toBe(true);
      expect(paths.some((relativePath) => relativePath.includes("baseline"))).toBe(false);
      expect(computeCorpusSha256(enumerated)).toBe(manualDigest(enumerated));
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("T177 rejects a symlink entry without following it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "roastpilot-corpus-link-"));
    try {
      const root = join(parent, "corpus");
      await mkdir(root);
      await writeFile(join(parent, "outside"), "outside bytes");
      await symlink(join(parent, "outside"), join(root, "linked"));
      await expect(enumerateCorpusFiles(root, "eval/corpus/")).rejects.toThrow(
        /not a regular file or directory/,
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("T178 enumerates the real corpus completely and deterministically", async () => {
    const root = fileURLToPath(new URL("../../eval/corpus/", import.meta.url));
    const first = await enumerateCorpusFiles(root, "eval/corpus/");
    const second = await enumerateCorpusFiles(root, "eval/corpus/");
    const paths = first.map((entry) => entry.relativePath);
    expect(paths).toContain("eval/corpus/manifest.json");
    expect(paths).toContain("eval/corpus/README.md");
    expect(paths.some((relativePath) => relativePath.startsWith("eval/corpus/inputs/"))).toBe(true);
    expect(paths.some((relativePath) => relativePath.startsWith("eval/corpus/expectations/"))).toBe(true);
    expect(paths.every((relativePath) => relativePath.startsWith("eval/corpus/"))).toBe(true);
    expect(computeCorpusSha256(second)).toBe(computeCorpusSha256(first));
  });
});
