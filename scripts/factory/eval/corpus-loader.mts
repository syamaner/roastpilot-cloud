import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_DECISION_CONTEXT_BYTES,
  MAX_RECORDED_PATCH_BYTES,
  assembleCorpus,
  type LoadedCorpus,
  type LoadResult,
} from "./corpus-loader-logic.mts";
import { MAX_EXPECTED_BYTES } from "./expected-result-schema.mts";
import { MAX_MANIFEST_BYTES } from "./corpus-manifest-schema.mts";
import { MAX_SNAPSHOT_BYTES } from "./issue-snapshot-schema.mts";
import { MAX_PAYLOAD_BYTES } from "../triage-verdict-schema.mts";
import type { CorpusFileInput } from "./eval-corpus-hash.mts";

export const CORPUS_REPO_PREFIX = "eval/corpus/";

export type CorpusSnapshotResult =
  | {
      readonly ok: true;
      readonly value: LoadedCorpus;
      readonly hashInput: readonly CorpusFileInput[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

type CorpusFilesResult =
  | {
      readonly ok: true;
      readonly rawFiles: CorpusFileInput[];
      readonly textFiles: Map<string, string>;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function byteLimit(path: string): number {
  if (path === "manifest.json") return MAX_MANIFEST_BYTES;
  if (path.endsWith("/issue-snapshot.json")) return MAX_SNAPSHOT_BYTES;
  if (path.endsWith("/expected.json")) return MAX_EXPECTED_BYTES;
  if (path.endsWith("/triage-verdict.json")) return MAX_PAYLOAD_BYTES;
  if (path.endsWith("/implement.patch")) return MAX_RECORDED_PATCH_BYTES;
  return MAX_DECISION_CONTEXT_BYTES;
}

async function readCorpusFiles(
  root: string,
  repoRelativePrefix: string,
): Promise<CorpusFilesResult> {
  const errors: string[] = [];
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch {
    return { ok: false, errors: [`corpus root ${root} cannot be resolved`] };
  }
  if (rootMetadata.isSymbolicLink()) {
    return { ok: false, errors: [`corpus root ${root} is a symlink`] };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  /* v8 ignore start -- TOCTOU/permission-only: lstat already proved a present non-symlink root */
  } catch {
    return { ok: false, errors: [`corpus root ${root} cannot be resolved`] };
  }
  /* v8 ignore stop */
  const rawFiles: CorpusFileInput[] = [];
  const textFiles = new Map<string, string>();
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(`${directory} cannot be enumerated`);
      continue;
    }
    for (const entry of entries) {
      const lexicalPath = resolve(directory, entry.name);
      let lexicalMetadata;
      try {
        lexicalMetadata = await lstat(lexicalPath);
      /* v8 ignore start -- TOCTOU-only: the entry would have to disappear after readdir */
      } catch {
        errors.push(`${lexicalPath} cannot be inspected without following links`);
        continue;
      }
      /* v8 ignore stop */
      if (lexicalMetadata.isSymbolicLink()) {
        errors.push(`${lexicalPath} is a symlink`);
        continue;
      }
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(lexicalPath);
      /* v8 ignore start -- TOCTOU-only: lstat already proved a present non-symlink entry */
      } catch {
        errors.push(`${lexicalPath} cannot be resolved`);
        continue;
      }
      /* v8 ignore stop */
      // Containment is checked before opening, recursion, or content reads.
      /* v8 ignore start -- TOCTOU-only: requires replacement with an external symlink after lstat */
      if (!contained(canonicalRoot, canonicalPath)) {
        errors.push(`${lexicalPath} resolves outside corpus root`);
        continue;
      }
      /* v8 ignore stop */
      if (lexicalMetadata.isDirectory()) {
        pending.push(canonicalPath);
      } else {
        /* v8 ignore else -- non-regular nodes are outside the enumerate-regular-files contract and cannot be created in the sandbox */
        if (lexicalMetadata.isFile()) {
          const corpusPath = relative(canonicalRoot, lexicalPath).split(sep).join("/");
          const limit = byteLimit(corpusPath);

          let handle;
          try {
            handle = await open(canonicalPath, "r");
          /* v8 ignore start -- TOCTOU/permission-only: an inspected file may become unreadable before open */
          } catch {
            errors.push(`${corpusPath} cannot be read`);
            continue;
          }
          /* v8 ignore stop */

          try {
            try {
              const info = await handle.stat();
              if (info.size > limit) {
                errors.push(`${corpusPath} exceeds ${String(limit)} bytes`);
                continue;
              }
              const content = await handle.readFile();
              let text: string;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(content);
              } catch {
                errors.push(`${corpusPath} is not valid UTF-8`);
                continue;
              }
              rawFiles.push({
                relativePath: `${repoRelativePrefix}${corpusPath}`,
                bytes: content,
              });
              textFiles.set(corpusPath, text);
            /* v8 ignore start -- descriptor I/O can fail after a successful open */
            } catch {
              errors.push(`${corpusPath} cannot be read`);
            }
            /* v8 ignore stop */
          } finally {
            try {
              await handle.close();
            /* v8 ignore start -- descriptor close failure is platform/resource-only */
            } catch {
              errors.push(`${corpusPath} cannot be closed`);
            }
            /* v8 ignore stop */
          }
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rawFiles, textFiles };
}

function assembleLoadedCorpus(
  textFiles: Map<string, string>,
): LoadResult {
  const manifestText = textFiles.get("manifest.json");
  if (manifestText === undefined) return { ok: false, errors: ["manifest.json is missing"] };
  textFiles.delete("manifest.json");
  return assembleCorpus(manifestText, textFiles);
}

export async function loadCorpus(root: string): Promise<LoadResult> {
  const loaded = await readCorpusFiles(root, CORPUS_REPO_PREFIX);
  if (!loaded.ok) return loaded;
  return assembleLoadedCorpus(loaded.textFiles);
}

export async function loadCorpusSnapshot(
  root: string,
  repoRelativePrefix: string,
): Promise<CorpusSnapshotResult> {
  const loaded = await readCorpusFiles(root, repoRelativePrefix);
  if (!loaded.ok) return loaded;
  const assembled = assembleLoadedCorpus(loaded.textFiles);
  if (!assembled.ok) return assembled;
  return {
    ok: true,
    value: assembled.value,
    hashInput: loaded.rawFiles,
  };
}
