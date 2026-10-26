export type Bump = 'patch' | 'minor' | 'major';
export interface MarketplaceVersion { version: string; preRelease: boolean }
export type PublishCheck = { action: 'publish' | 'finish' } | { action: 'refuse'; reason: string };

export function parse(version: string): [number, number, number];
export function compare(a: string, b: string): number;
export function prereleaseMinor(version: string): number;
export function nextStable(version: string, bump: Bump): string;
export function streamTag(version: string, tags: string[]): string | undefined;
export function nextPrerelease(version: string, tags: string[]): string;
export function newestPrereleaseTag(tags: string[]): string | undefined;
export function previousStableTag(version: string, tags: string[]): string | undefined;
export function prereleaseNotesStart(version: string, publishedTags: string[], tags: string[]): string | undefined;
export function publishCheck(version: string, marketplace: MarketplaceVersion[]): PublishCheck;
export function toPrune(versions: MarketplaceVersion[], keep: number): string[];
