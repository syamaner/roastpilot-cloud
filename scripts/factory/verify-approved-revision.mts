import { promises as fs } from "node:fs";

import { computeApprovedRevision } from "./approve-revision.mts";
import {
  APPROVED_REVISION_MARKER_PREFIX,
  extractApprovedRevision,
} from "./apply-triage-verdict-logic.mts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyApprovedRevision(
  currentBody: string,
  authorizingCommentBody: string,
): void {
  const approvedRevision = extractApprovedRevision(authorizingCommentBody);
  if (approvedRevision === null) {
    if (authorizingCommentBody.includes(APPROVED_REVISION_MARKER_PREFIX)) {
      throw new Error("malformed approved-revision marker");
    }
    return;
  }
  if (computeApprovedRevision(currentBody) !== approvedRevision) {
    throw new Error(
      "current issue body does not match the owner-approved revision",
    );
  }
}

export async function main(): Promise<void> {
  const contextPath = process.env.ISSUE_CONTEXT_PATH;
  if (!contextPath) {
    throw new Error("missing required environment variable: ISSUE_CONTEXT_PATH");
  }
  const raw = JSON.parse(await fs.readFile(contextPath, "utf8")) as unknown;
  if (!isRecord(raw) || typeof raw.body !== "string" || !Array.isArray(raw.comments)) {
    throw new TypeError("issue context has malformed body or comments");
  }
  const histories = raw.comments.filter(
    (comment): comment is Record<string, unknown> =>
      isRecord(comment) && comment.kind === "factory_triage_history",
  );
  if (histories.length !== 1 || typeof histories[0]?.body !== "string") {
    throw new Error("expected exactly one authorizing triage comment body");
  }
  verifyApprovedRevision(raw.body, histories[0].body);
}

/* v8 ignore next 6 -- exercised by the workflow-contract subprocess test. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
