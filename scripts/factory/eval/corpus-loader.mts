import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_DECISION_CONTEXT_BYTES,
  MAX_RECORDED_PATCH_BYTES,
  assembleCorpus,
  type LoadResult,
} from "./corpus-loader-logic.mts";
import { MAX_EXPECTED_BYTES } from "./expected-result-schema.mts";
import { MAX_MANIFEST_BYTES } from "./corpus-manifest-schema.mts";
import { MAX_SNAPSHOT_BYTES } from "./issue-snapshot-schema.mts";
import { MAX_PAYLOAD_BYTES } from "../triage-verdict-schema.mts";

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

export async function loadCorpus(root: string): Promise<LoadResult> {
  const errors: string[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { ok: false, errors: [`corpus root ${root} cannot be resolved`] };
  }
  const files = new Map<string, string>();
  const pending = [canonicalRoot];
  const visitedDirectories = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    if (visitedDirectories.has(directory)) continue;
    visitedDirectories.add(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(`${directory} cannot be enumerated`);
      continue;
    }
    for (const entry of entries) {
      const lexicalPath = resolve(directory, entry.name);
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(lexicalPath);
      } catch {
        errors.push(`${lexicalPath} cannot be resolved`);
        continue;
      }
      // Containment is checked before stat, recursion, or content reads.
      if (!contained(canonicalRoot, canonicalPath)) {
        errors.push(`${lexicalPath} resolves outside corpus root`);
        continue;
      }
      let metadata;
      try {
        metadata = await stat(canonicalPath);
      } catch {
        errors.push(`${lexicalPath} cannot be inspected`);
        continue;
      }
      if (metadata.isDirectory()) {
        pending.push(canonicalPath);
      } else if (metadata.isFile()) {
        const corpusPath = relative(canonicalRoot, lexicalPath).split(sep).join("/");
        const limit = byteLimit(corpusPath);
        if (metadata.size > limit) {
          errors.push(`${corpusPath} exceeds ${String(limit)} bytes`);
          continue;
        }
        try {
          const content = await readFile(canonicalPath);
          if (content.byteLength > limit) {
            errors.push(`${corpusPath} exceeds ${String(limit)} bytes`);
            continue;
          }
          files.set(corpusPath, content.toString("utf8"));
        } catch {
          errors.push(`${corpusPath} cannot be read`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const manifestText = files.get("manifest.json");
  if (manifestText === undefined) return { ok: false, errors: ["manifest.json is missing"] };
  files.delete("manifest.json");
  return assembleCorpus(manifestText, files);
}
