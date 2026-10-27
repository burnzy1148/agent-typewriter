// Version arithmetic for the two release channels. Stable versions keep even
// minors; pre-releases use the first odd minor above the stable one, so every
// pre-release sorts above the stable release it follows and below the next.
// Pre-release tags are pre-v<version>; stable tags are v<version>.
// scripts/version-cli.mjs is the CLI the workflows call.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const PRE_TAG = /^pre-v(\d+\.\d+\.\d+)$/;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

export function parse(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`Not a major.minor.patch version: ${version}`);
  return m.slice(1).map(Number);
}

export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const newestFirst = (versions) => [...versions].sort((a, b) => compare(b, a));

function tagVersions(tags, pattern) {
  return tags.map((t) => pattern.exec(t.trim())?.[1]).filter(Boolean);
}

export function prereleaseMinor(version) {
  const [, minor] = parse(version);
  return minor % 2 === 0 ? minor + 1 : minor + 2;
}

export function nextStable(version, bump) {
  const [major, minor, patch] = parse(version);
  switch (bump) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${prereleaseMinor(version) + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default: throw new Error(`Unknown bump: ${bump}`);
  }
}

// The newest pre-v tag in the stream that follows this stable version, if any.
export function streamTag(version, tags) {
  const [major] = parse(version);
  const minor = prereleaseMinor(version);
  const newest = newestFirst(tagVersions(tags, PRE_TAG))
    .find((v) => { const [ma, mi] = parse(v); return ma === major && mi === minor; });
  return newest && `pre-v${newest}`;
}

export function nextPrerelease(version, tags) {
  const [major] = parse(version);
  const minor = prereleaseMinor(version);
  const latest = streamTag(version, tags);
  const n = latest ? parse(latest.slice('pre-v'.length))[2] + 1 : 0;
  return `${major}.${minor}.${n}`;
}

export function newestPrereleaseTag(tags) {
  const newest = newestFirst(tagVersions(tags, PRE_TAG))[0];
  return newest && `pre-v${newest}`;
}

// The highest stable tag below version, where generated release notes start.
export function previousStableTag(version, tags) {
  const previous = newestFirst(tagVersions(tags, STABLE_TAG)).find((v) => compare(v, version) < 0);
  return previous && `v${previous}`;
}

// Where a pre-release's notes start: the newest published pre-release below
// it, else the newest stable tag below it.
export function prereleaseNotesStart(version, publishedTags, tags) {
  const previous = newestFirst(tagVersions(publishedTags, PRE_TAG)).find((v) => compare(v, version) < 0);
  return previous ? `pre-v${previous}` : previousStableTag(version, tags);
}

// Whether to publish version given the Marketplace's versions
// ({ version, preRelease }): 'finish' when it is already published as a
// pre-release, 'publish' when it is above them all, else a refusal.
export function publishCheck(version, marketplace) {
  parse(version);
  const same = marketplace.find((v) => v.version === version);
  if (same) {
    return same.preRelease
      ? { action: 'finish' }
      : { action: 'refuse', reason: `${version} is already on the Marketplace as a stable version` };
  }
  const highest = newestFirst(marketplace.map((v) => v.version))[0];
  if (highest && compare(highest, version) > 0) {
    return { action: 'refuse', reason: `${highest} is already on the Marketplace and is higher than ${version}, so testers would not get it` };
  }
  return { action: 'publish' };
}

// The pre-release versions beyond the newest keep. Never a stable version.
export function toPrune(versions, keep) {
  return newestFirst(versions.filter((v) => v.preRelease).map((v) => v.version)).slice(keep);
}
