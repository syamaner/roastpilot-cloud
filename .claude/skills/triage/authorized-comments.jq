def factory_marker:
  "<!-- roastpilot-factory:triage-verdict:do-not-edit -->";

def max_retained_comments: 50;
def max_context_bytes: 65536;

def trusted_association:
  . == "OWNER" or . == "MEMBER" or . == "COLLABORATOR";

def is_factory_history:
  (.author.login // null) == "github-actions"
  and (
    (.body // "") == factory_marker
    or ((.body // "") | endswith("\n" + factory_marker))
  );

def is_authorized_clarification($issue_author):
  (.author.login // null) as $comment_author
  | $comment_author != null
    and $comment_author != "github-actions"
    and (
      ($issue_author != null and $comment_author == $issue_author)
      or (.authorAssociation | trusted_association)
    );

. as $issue
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
            body
          }
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
