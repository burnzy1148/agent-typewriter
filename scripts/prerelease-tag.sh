#!/usr/bin/env bash
# Decides whether HEAD, a develop commit that passed CI, gets the next
# pre-release tag, and if so creates it locally and prints its name. It prints
# nothing, and says why on stderr, for a version-bump merge, a commit that is
# already tagged, and a commit older than the newest tag in its stream, so tags
# rise along develop's history. ci.yml's prerelease-tag job pushes the tag.
# Needs full history and tags.
set -euo pipefail

version=$(node -p "require('./package.json').version")
previous=$(git show HEAD^:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
if [ "$version" != "$previous" ]; then
  echo "Version bump ($previous -> $version): no pre-release tag" >&2
  exit 0
fi

existing=$(git tag -l 'pre-v*' --points-at HEAD)
if [ -n "$existing" ]; then
  echo "Already tagged $existing" >&2
  exit 0
fi

stream=$(node scripts/version-cli.mjs stream-tag)
if [ -n "$stream" ] && ! git merge-base --is-ancestor "$stream" HEAD; then
  echo "$(git rev-parse --short HEAD) is older than $stream: no pre-release tag" >&2
  exit 0
fi

tag="pre-v$(node scripts/version-cli.mjs next-prerelease)"
git tag "$tag"
echo "$tag"
