export interface StoryPlannerMarkerComment {
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}
const STORY_PLANNER_BOT_AUTHOR_LOGIN = "github-actions[bot]";
export function isStoryPlannerBotMarkerComment(
  comment: StoryPlannerMarkerComment,
  marker: string,
): boolean {
  return (
    comment.user?.type === "Bot" &&
    comment.user.login === STORY_PLANNER_BOT_AUTHOR_LOGIN &&
    (comment.body === marker || comment.body.endsWith(`\n${marker}`))
  );
}
