#!/bin/sh
# Sync the committed public spec + generated client with prod, and open (or
# update) one PR from a fixed branch. Run by .github/workflows/spec-sync.yml;
# idempotent: no spec change -> no PR (and a stale sync PR is closed), same
# change -> the open PR is left as is, new change -> its branch and body update.
#
# Env:
#   SPEC_URL        spec to sync to (default: prod; a local file works too)
#   IMAGE_TAG, PREVIOUS_TAG   from the prod-promoted dispatch payload, for the PR body
#   DRY_RUN=1       print the summary and diff, touch nothing remote
#   SPEC_SYNC_SKIP_TESTS=1    skip typecheck/tests (the repo's own test of this script)
#   SYNC_BRANCH (default bot/spec-sync), BASE_BRANCH (default main)
set -eu

SPEC_URL="${SPEC_URL:-https://api.topcited.ai/api/v1/openapi.public.json}"
SYNC_BRANCH="${SYNC_BRANCH:-bot/spec-sync}"
BASE_BRANCH="${BASE_BRANCH:-main}"
TITLE="chore(api): sync generated client with the prod public spec"
# Generated files the sync owns: openapi.public.json src/generated

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp openapi.public.json "$work/old.json"

bun run gen:client --fetch "$SPEC_URL" >&2

open_pr() {
  [ -n "${DRY_RUN:-}" ] && return 0
  gh pr list --head "$SYNC_BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty'
}

# Unchanged, or only formatting/key order changed: nothing to review.
if git diff --quiet -- openapi.public.json src/generated || bun run scripts/spec-diff.ts "$work/old.json" openapi.public.json --exit-code; then
  git checkout -q -- openapi.public.json src/generated
  echo "Spec unchanged: $BASE_BRANCH already matches $SPEC_URL."
  pr="$(open_pr)"
  if [ -n "$pr" ]; then
    gh pr close "$pr" --delete-branch --comment "Closing: \`$BASE_BRANCH\` already matches the prod public spec."
  fi
  exit 0
fi

bun run scripts/spec-diff.ts "$work/old.json" openapi.public.json \
  --image-tag "${IMAGE_TAG:-}" --previous-tag "${PREVIOUS_TAG:-}" --source "$SPEC_URL" > "$work/body.md"

checks_ok=1
if [ -z "${SPEC_SYNC_SKIP_TESTS:-}" ]; then
  if ! { bun run typecheck && bun test; } >&2; then
    checks_ok=0
    # shellcheck disable=SC2016 # the backticks are Markdown, not command substitution
    printf '\n> ⚠ **`bun run typecheck` / `bun test` fail on the regenerated client.** The CLI uses something that changed; fix it on this branch before merging.\n' >> "$work/body.md"
  fi
fi

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY RUN: would open/update a PR from $SYNC_BRANCH with this body:"
  cat "$work/body.md"
  git --no-pager diff --stat -- openapi.public.json src/generated
  [ "$checks_ok" = 1 ]
  exit
fi

git config user.name "topcited-spec-sync[bot]"
git config user.email "spec-sync@users.noreply.github.com"
git checkout -B "$SYNC_BRANCH"
git add -- openapi.public.json src/generated
git commit -q -m "$TITLE${IMAGE_TAG:+ ($IMAGE_TAG)}"

# Only push when the generated files differ from what the bot branch already has.
if git fetch -q origin "$SYNC_BRANCH" 2>/dev/null && git diff --quiet FETCH_HEAD HEAD -- openapi.public.json src/generated \
  && [ "$(git merge-base FETCH_HEAD "origin/$BASE_BRANCH")" = "$(git rev-parse "origin/$BASE_BRANCH")" ]; then
  echo "$SYNC_BRANCH already has this spec."
else
  git push -q --force origin "HEAD:refs/heads/$SYNC_BRANCH"
fi

pr="$(open_pr)"
if [ -n "$pr" ]; then
  # `gh pr edit` is unreliable on repos with Projects (classic) history; use the REST API.
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$pr" -f title="$TITLE" -F body=@"$work/body.md" > /dev/null
  echo "Updated #$pr"
else
  gh pr create --base "$BASE_BRANCH" --head "$SYNC_BRANCH" --title "$TITLE" --body-file "$work/body.md"
fi

[ "$checks_ok" = 1 ]
