// The extension's versions on the Visual Studio Code Marketplace, through the
// Gallery API (vsce has no command to remove a single version).
//
//   versions                                    JSON [{ version, preRelease }], newest first
//   prune --keep <n> [--include <v>] [--dry-run] remove pre-releases beyond the newest n
//
// Removing reads VSCE_PAT; listing needs no token. --include counts
// a just-published version the listing may not show yet. A version without the
// pre-release flag is never removed.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import gallery from 'azure-devops-node-api/GalleryApi.js';
import webApi from 'azure-devops-node-api/WebApi.js';
import interfaces from 'azure-devops-node-api/interfaces/GalleryInterfaces.js';
import { toPrune } from './version.mjs';

const MARKETPLACE = 'https://marketplace.visualstudio.com';
const PRE_RELEASE = 'Microsoft.VisualStudio.Code.PreRelease';
const { publisher, name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const pat = process.env.VSCE_PAT;

// The public query vsce show uses; it needs no token.
async function versions() {
  const { ExtensionQueryFlags: f } = interfaces;
  const response = await fetch(`${MARKETPLACE}/_apis/public/gallery/extensionquery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }] }],
      flags: f.IncludeVersions | f.IncludeVersionProperties,
    }),
  });
  if (!response.ok) throw new Error(`Marketplace query failed: ${response.status} ${response.statusText}`);
  const extension = (await response.json()).results?.[0]?.extensions?.[0];
  if (!extension) throw new Error(`${publisher}.${name} is not on the Marketplace`);
  return (extension.versions ?? []).map((v) => ({
    version: v.version,
    preRelease: (v.properties ?? []).some((p) => p.key === PRE_RELEASE && p.value === 'true'),
  }));
}

async function prune({ keep, include, dryRun }) {
  const listed = await versions();
  const all = include && !listed.some((v) => v.version === include)
    ? [...listed, { version: include, preRelease: true }]
    : listed;
  const remove = toPrune(all, keep);
  if (remove.length === 0) console.log(`Nothing to remove: at most ${keep} pre-releases.`);
  for (const version of remove) {
    const entry = listed.find((v) => v.version === version);
    if (!entry?.preRelease) throw new Error(`Refusing to remove ${version}: not listed as a pre-release`);
    if (dryRun) {
      console.log(`Would remove ${publisher}.${name}@${version}`);
      continue;
    }
    if (!pat) throw new Error('VSCE_PAT is needed to remove versions');
    const api = new gallery.GalleryApi(MARKETPLACE, [webApi.getBasicHandler('OAuth', pat)]);
    await api.deleteExtension(publisher, name, version);
    console.log(`Removed ${publisher}.${name}@${version}`);
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { keep: { type: 'string' }, include: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});

try {
  switch (positionals[0]) {
    case 'versions':
      console.log(JSON.stringify(await versions()));
      break;
    case 'prune': {
      const keep = Number(values.keep);
      if (!Number.isInteger(keep) || keep < 0) throw new Error('prune needs --keep <n>, n >= 0');
      await prune({ keep, include: values.include, dryRun: values['dry-run'] });
      break;
    }
    default:
      throw new Error(`Unknown command: ${positionals[0] ?? '(none)'}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
