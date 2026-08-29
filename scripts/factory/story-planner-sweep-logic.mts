import {
  STORY_PLANNER_CONTRACT_MARKER,
  STORY_PLANNER_ESCALATE_MARKER,
} from "./post-story-planner-contract.mts";
import {
  isStoryPlannerBotMarkerComment,
  type StoryPlannerMarkerComment,
} from "./story-planner-marker.mts";

export const READY_TO_SPEC_LABEL = "ready-to-spec";
export interface SweepIssue {
  readonly number: number;
  readonly state: "open" | "closed";
}

export type SweepLabelOperation =
  | { readonly method: "DELETE"; readonly label: typeof READY_TO_SPEC_LABEL }
  | { readonly method: "POST"; readonly label: typeof READY_TO_SPEC_LABEL };

export function computeSweepLabelOperations(): readonly SweepLabelOperation[] {
  return [
    { method: "DELETE", label: READY_TO_SPEC_LABEL },
    { method: "POST", label: READY_TO_SPEC_LABEL },
  ];
}

export function isIssueHandled(
  comments: readonly StoryPlannerMarkerComment[],
  issueNumber: number,
): boolean {
  const markers = [
    STORY_PLANNER_CONTRACT_MARKER(issueNumber),
    STORY_PLANNER_ESCALATE_MARKER(issueNumber),
  ];
  return markers.some((marker) =>
    comments.some((comment) => isStoryPlannerBotMarkerComment(comment, marker)),
  );
}

export type SweepDecision =
  | { readonly kind: "skip-handled" }
  | { readonly kind: "log-closed" }
  | {
      readonly kind: "relabel";
      readonly operations: readonly SweepLabelOperation[];
    };

export function decideSweepIssue(
  issue: SweepIssue,
  comments: readonly StoryPlannerMarkerComment[],
): SweepDecision {
  if (isIssueHandled(comments, issue.number)) {
    return { kind: "skip-handled" };
  }
  if (issue.state === "closed") {
    return { kind: "log-closed" };
  }
  return { kind: "relabel", operations: computeSweepLabelOperations() };
}
