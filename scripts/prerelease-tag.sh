#!/usr/bin/env bash
# Decides whether HEAD, a develop commit that passed CI, gets the next
# pre-release tag, and if so creates it locally and prints its name. It prints
# nothing, and says why on stderr, for a version-bump merge, a commit that is
# already tagged, a commit older than the newest tag in its stream (so tags
# rise along develop's history), and a commit that changes only the site since
# the last tag. ci.yml's prerelease-tag job pushes the tag. (ci.yml's changes
# job classifies paths on pull requests only, so a push needs this check.)
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

# Site-only since the last tag in the stream (or the stable release): the
# extension is unchanged. Diffing from there rather than from HEAD^ keeps a
# cancelled run's changes counted when a site-only merge follows them.
base=${stream:-}
if [ -z "$base" ] && git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  base="v$version"
fi
if [ -n "$base" ]; then
  changes=$(git diff -z --name-only --no-renames "$base" HEAD | GITHUB_OUTPUT='' node scripts/ci-changes.mjs)
  if [ "$changes" = "extension=false" ]; then
    echo "Only the site changed since $base: no pre-release tag" >&2
    exit 0
  fi
fi

tag="pre-v$(node scripts/version-cli.mjs next-prerelease)"
git tag "$tag"
echo "$tag"
