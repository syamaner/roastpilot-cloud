export interface StoryPlannerMarkerComment {
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}
const STORY_PLANNER_BOT_AUTHOR_LOGIN = "github-actions[bot]";

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
