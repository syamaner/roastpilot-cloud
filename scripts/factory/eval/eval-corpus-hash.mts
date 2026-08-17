import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface CorpusFileInput {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

const CORPUS_PATH_PATTERN = /^[A-Za-z0-9._\/-]+$/;

function validRelativePath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    !CORPUS_PATH_PATTERN.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("//") ||
    relativePath.includes("\\")
  ) {
    return false;
  }
  return relativePath.split("/").every((segment) =>
    segment !== "." && segment !== "..");
}

export function computeCorpusSha256(
  files: readonly CorpusFileInput[],
): string {
  if (files.length === 0) throw new Error("corpus file set must not be empty");
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (!validRelativePath(file.relativePath)) {
      throw new Error(`invalid corpus relative path: ${file.relativePath}`);
    }
    if (seenPaths.has(file.relativePath)) {
      throw new Error(`duplicate corpus relative path: ${file.relativePath}`);
    }
    seenPaths.add(file.relativePath);
  }

  // The closed grammar is ASCII-only, so code-unit order equals UTF-8 byte order.
  const canonical = [...files].sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : /* v8 ignore next -- relativePaths are deduped; the equal branch is unreachable */ 0);
  const hash = createHash("sha256");
  for (const file of canonical) {
    hash.update(
      `${file.relativePath}\0${String(file.bytes.byteLength)}\0`,
      "utf8",
    );
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export async function enumerateCorpusFiles(
  corpusRootAbsolute: string,
  repoRelativePrefix: string,
): Promise<CorpusFileInput[]> {
  const entries = await readdir(corpusRootAbsolute, {
    recursive: true,
    withFileTypes: true,
  });
  const files: CorpusFileInput[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error(`corpus entry is not a regular file or directory: ${entry.name}`);
    }
    if (!entry.isFile()) continue;
    const absolutePath = path.resolve(entry.parentPath, entry.name);
    const rootRelativePath = path
      .relative(corpusRootAbsolute, absolutePath)
      .split(path.sep)
      .join("/");
    files.push({
      relativePath: `${repoRelativePrefix}${rootRelativePath}`,
      bytes: await readFile(absolutePath),
    });
  }
  // This filesystem set includes manifest.json, README.md, inputs/**,
  // expectations/**, dotfiles, and untracked files. A stray file changes the
  // digest and fails closed. The baseline subtree is structurally excluded
  // because it is a sibling of the enumerated eval/corpus root.
  return files;
}
