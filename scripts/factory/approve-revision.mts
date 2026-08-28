import { createHash } from "node:crypto";

export const APPROVED_REVISION_PATTERN = /^[0-9a-f]{64}$/;

export function computeApprovedRevision(body: string): string {
  if (typeof body !== "string") {
    throw new TypeError("approved issue body must be a string");
  }
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function isApprovedRevision(raw: unknown): boolean {
  return typeof raw === "string" && APPROVED_REVISION_PATTERN.test(raw);
}
