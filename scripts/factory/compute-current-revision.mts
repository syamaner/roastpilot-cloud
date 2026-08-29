import { readFileSync } from "node:fs";

import { canonicalIssueRevision } from "./approve-revision.mts";

const issue = JSON.parse(readFileSync(0, "utf8")) as unknown;
if (
  typeof issue !== "object" ||
  issue === null ||
  !("title" in issue) ||
  typeof issue.title !== "string"
) {
  throw new Error("REST issue title is malformed");
}
if (
  !("body" in issue) ||
  (typeof issue.body !== "string" && issue.body !== null)
) {
  throw new Error("REST issue body is malformed");
}
process.stdout.write(canonicalIssueRevision(issue.title, issue.body));
