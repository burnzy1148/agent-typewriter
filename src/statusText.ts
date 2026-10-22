/** What the status bar entries and the panel show; kept free of vscode so it can be unit-tested. */
export interface StatusInput {
  watching: boolean;
  paused: boolean;
  pending: number;
  speed: number;
  watchedCount: number;
  /** The recorder's filter summary; it starts with "<profile>: " while a profile is active. */
  filter: string;
  /** The active profile's name, '' when none is active; only read while not watching. */
  profile: string;
  /** The checkout each folder in git records. */
  checkouts: Array<{ own: boolean; name: string; worktrees: number }>;
}

export interface StatusPresentation {
  text: string;
  tooltip: string;
  command: string;
  /** The timeline panel's description. */
  description: string;
  /** The checkout entry, undefined when no folder has another checkout to choose. */
  checkout: { text: string; tooltip: string } | undefined;
}

export function statusPresentation(s: StatusInput): StatusPresentation {
  const speed = s.speed === 1 ? '' : ` ${s.speed}x`;
  const queued = s.pending ? ` · ${s.pending} queued` : '';
  const elsewhere = s.checkouts.filter((c) => !c.own).map((c) => c.name);
  const inCheckout = elsewhere.length > 0 ? ` in checkout ${elsewhere.join(', ')}` : '';
  const profile = s.profile ? ` (profile ${s.profile})` : '';
  const watched = `Watching ${s.watchedCount} files${inCheckout} (${s.filter})`;
  const choosable = s.checkouts.filter((c) => c.worktrees > 1).map((c) => c.name);
  const checkout =
    choosable.length > 0
      ? {
          text: `$(git-branch) ${choosable.join(', ')}`,
          tooltip: `Agent Typewriter ${s.watching ? 'records' : 'will record'} checkout ${choosable.join(', ')}. Click to choose another.`,
        }
      : undefined;
  // The filter summary leads, so an active profile's name starts the description.
  const description = s.watching
    ? s.filter + (elsewhere.length > 0 ? ` · checkout ${elsewhere.join(', ')}` : '')
    : 'stopped' + (s.profile ? ` · profile ${s.profile}` : '');
  if (!s.watching && s.pending === 0) {
    return {
      text: '$(keyboard) Typewriter',
      tooltip: `Agent Typewriter is not watching${profile}. Click to start.`,
      command: 'agentTypewriter.start',
      description,
      checkout,
    };
  }
  if (s.paused) {
    return {
      text: `$(debug-pause) Typewriter paused${queued}`,
      tooltip: `${s.watching ? watched : `Not watching${profile}`}. Click to resume playback.`,
      command: 'agentTypewriter.togglePause',
      description,
      checkout,
    };
  }
  return {
    text: `$(${s.watching ? 'record' : 'play'}) Typewriter${queued}${speed}`,
    tooltip: `${s.watching ? watched : `Not watching${profile}; draining the buffer`}. Click to pause.`,
    command: 'agentTypewriter.togglePause',
    description,
    checkout,
  };
}
