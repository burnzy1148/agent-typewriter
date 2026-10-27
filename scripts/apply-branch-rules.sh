#!/usr/bin/env bash
# Creates or updates the rulesets that protect main and develop: no deletion,
# no force pushes, changes only through PRs, and CI green before merge. main
# takes merge commits only (release PRs); develop takes squash for feature PRs
# and merge commits for branch merges. Repository admins can bypass the
# rules, for example to merge while CI is down.
#
# Rulesets need a public repository (or GitHub Pro). Run with a gh login that
# administers the repository:
#   scripts/apply-branch-rules.sh [owner/repo]
set -euo pipefail

repo=${1:-burnzy1148/agent-typewriter}

ruleset() {
  local name=$1 branch=$2 methods=$3
  cat <<EOF
{
  "name": "$name",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/$branch"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": $methods
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Test (ubuntu-latest)", "integration_id": 15368 },
          { "context": "Test (windows-latest)", "integration_id": 15368 },
          { "context": "Package .vsix", "integration_id": 15368 }
        ]
      }
    }
  ]
}
EOF
}

apply() {
  local name=$1
  local id
  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")
  if [ -n "$id" ]; then
    ruleset "$@" | gh api -X PUT "repos/$repo/rulesets/$id" --input - --jq '"updated \(.name) (\(.id))"'
  else
    ruleset "$@" | gh api -X POST "repos/$repo/rulesets" --input - --jq '"created \(.name) (\(.id))"'
  fi
}

apply "Protect main" main '["merge"]'
apply "Protect develop" develop '["squash", "merge"]'
