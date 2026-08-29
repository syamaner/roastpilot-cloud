def factory_marker:
  "<!-- roastpilot-factory:triage-verdict:do-not-edit -->";

def max_retained_comments: 50;
def max_context_bytes: 65536;
def contract_excerpt_max_bytes: 32000;
def contract_excerpt_truncation_disclosure:
  "\n\n_[contract excerpt truncated for the triage context; full contract is on the issue.]_";

def story_planner_contract_marker($issue_number):
  "<!-- story-planner-contract:issue-" + ($issue_number | tostring);

def story_planner_contract_binding($issue_number):
  try (
    capture(
      "(^|\\n)"
      + story_planner_contract_marker($issue_number)
      + "(?<binding>(:[^\\r\\n]*)?) -->$"
    )
  )
  catch null;

def story_planner_contract_revision($issue_number):
  story_planner_contract_binding($issue_number) as $marker
  | (($marker.binding | capture("^:rev-(?<revision>[0-9a-f]{64})$").revision) // null);

def triage_generation:
  try (
    capture(
      "(^|\n)<!-- roastpilot-factory:triage-generation:(?<generation>hold:[1-9][0-9]*\\.[1-9][0-9]*|[1-9][0-9]*(\\.[1-9][0-9]*)?):do-not-edit -->\\r?\n"
      + factory_marker
      + "$"
    ).generation
    // "none"
  )
  catch "none";

def trusted_association:
  . == "OWNER" or . == "MEMBER" or . == "COLLABORATOR";

def is_factory_history:
  (.author.login // null) == "github-actions"
  and (
    (.body // "") == factory_marker
    or ((.body // "") | endswith("\n" + factory_marker))
  );

def is_story_planner_contract($issue_number):
  (.author.login // null) == "github-actions"
  and (((.body // "") | story_planner_contract_binding($issue_number)) != null);

def json_string_contribution:
  (tojson | utf8bytelength) - 2;

def byte_bounded_prefix($maxbytes):
  if json_string_contribution <= $maxbytes then
    .
  else
    (reduce (explode[]) as $cp
      ({acc: "", bytes: 0, done: false};
        if .done then
          .
        else
          ([$cp] | implode) as $ch
          | ($ch | json_string_contribution) as $char_bytes
          | if (.bytes + $char_bytes) <= $maxbytes then
              {
                acc: (.acc + $ch),
                bytes: (.bytes + $char_bytes),
                done: false
              }
            else
              {acc: .acc, bytes: .bytes, done: true}
            end
        end
      )
    ).acc
  end;

def contract_excerpt:
  if (tojson | utf8bytelength) > contract_excerpt_max_bytes then
    byte_bounded_prefix(
      contract_excerpt_max_bytes
      - 2
      - (contract_excerpt_truncation_disclosure | json_string_contribution)
    ) + contract_excerpt_truncation_disclosure
  else
    .
  end;

def is_authorized_clarification($issue_author):
  (.author.login // null) as $comment_author
  | $comment_author != null
    and $comment_author != "github-actions"
    and (
      ($issue_author != null and $comment_author == $issue_author)
      or (.authorAssociation | trusted_association)
    );

. as $issue
| ([.comments[] | select(is_story_planner_contract($issue.number))] | length) as $contract_count
| if $contract_count > 1 then
    error("authorized issue context contains more than one story-planner contract")
  else
    .
  end
| {
    number,
    title,
    body,
    state,
    comments: [
      .comments[]
      | if is_factory_history then
          {
            kind: "factory_triage_history",
            author: .author.login,
            author_association: .authorAssociation,
            created_at: .createdAt,
            triage_generation: (.body | triage_generation),
            body
          }
        elif is_story_planner_contract($issue.number) then
          ((.body // "") | story_planner_contract_revision($issue.number)) as $revision
          | if $revision == $current_revision then
              {
                kind: "story_planner_contract",
                author: .author.login,
                author_association: .authorAssociation,
                created_at: .createdAt,
                body: ((.body // "") | contract_excerpt)
              }
            else
              {
                kind: "story_planner_contract_stale",
                author: .author.login,
                author_association: .authorAssociation,
                created_at: .createdAt
              }
            end
        elif is_authorized_clarification($issue.author.login // null) then
          {
            kind: "authorized_clarification",
            author: .author.login,
            author_association: .authorAssociation,
            created_at: .createdAt,
            body
          }
        else
          empty
        end
    ]
  } as $context
| if ($context.comments | length) > max_retained_comments then
    error("authorized issue context exceeds the 50-comment limit")
  elif ($context | tojson | utf8bytelength) > max_context_bytes then
    error("authorized issue context exceeds the 65536-byte limit")
  else
    $context
  end
