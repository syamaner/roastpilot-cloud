export interface StoryPlannerMarkerComment {
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}
const STORY_PLANNER_BOT_AUTHOR_LOGIN = "github-actions[bot]";
const STORY_PLANNER_CONTRACT_PREFIX = "<!-- story-planner-contract:";

function stripSingleTrailingNewline(body: string): string {
  return body.replace(/\n$/u, "");
}

export function isStoryPlannerBotMarkerComment(
  comment: StoryPlannerMarkerComment,
  marker: string,
): boolean {
  const body = stripSingleTrailingNewline(comment.body);
  return (
    comment.user?.type === "Bot" &&
    comment.user.login === STORY_PLANNER_BOT_AUTHOR_LOGIN &&
    (body === marker || body.endsWith(`\n${marker}`))
  );
}

export function isStoryPlannerBotMarkerPrefixComment(
  comment: StoryPlannerMarkerComment,
  markerPrefix: string,
): boolean {
  const body = stripSingleTrailingNewline(comment.body);
  const finalLine = body.slice(body.lastIndexOf("\n") + 1);
  return (
    comment.user?.type === "Bot" &&
    comment.user.login === STORY_PLANNER_BOT_AUTHOR_LOGIN &&
    finalLine.startsWith(markerPrefix) &&
    finalLine.endsWith(" -->")
  );
}

/** Extract an exact, terminal, bot-authored contract revision for one issue. */
export function extractStoryPlannerContractRevision(
  comment: StoryPlannerMarkerComment,
  issueNumber: number,
): string | null {
  if (
    comment.user?.type !== "Bot" ||
    comment.user.login !== STORY_PLANNER_BOT_AUTHOR_LOGIN
  ) {
    return null;
  }
  const body = stripSingleTrailingNewline(comment.body);
  const finalLine = body.slice(body.lastIndexOf("\n") + 1);
  const issuePrefix = `${STORY_PLANNER_CONTRACT_PREFIX}issue-${issueNumber}:`;
  const match = new RegExp(
    `^<!-- story-planner-contract:issue-${issueNumber}:rev-([0-9a-f]{64}) -->$`,
    "u",
  ).exec(finalLine);
  if (match) return match[1]!;
  if (finalLine.startsWith(issuePrefix)) {
    throw new Error("malformed story-planner contract marker");
  }
  return null;
}
