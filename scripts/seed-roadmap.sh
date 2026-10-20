#!/usr/bin/env bash
# Seeds the Agent Typewriter roadmap into beads.
# Run once from the repo root after `bd init --prefix at`.
# Epics group themes; features are children with priorities and blocking deps.
# Each feature becomes an OpenSpec change only when it is picked up.
set -euo pipefail

epic()    { bd create "$1" -t epic -p "$2" -d "$3" --silent; }
feature() { local parent=$1 pri=$2 title=$3 desc=$4; shift 4
            bd create "$title" -t feature -p "$pri" --parent "$parent" -d "$desc" -l "needs-spec" "$@" --silent; }
issue()   { local parent=$1 type=$2 pri=$3 title=$4 desc=$5
            bd create "$title" -t "$type" -p "$pri" --parent "$parent" -d "$desc" --silent; }
blocks()  { bd dep add "$2" "$1" -t blocks >/dev/null; }   # $1 must finish before $2

# ---------------------------------------------------------------- epics
HARD=$(epic "Hardening and known gaps"   1 "Fix gaps found during the first build before adding surface area.")
CTX=$(epic  "Agent context"              1 "Tie each replayed change to what the agent was doing and why.")
SESS=$(epic "Sessions and persistence"   2 "Keep, save, and reload recorded timelines.")
PRES=$(epic "Presentation"               2 "Make playback watchable, controllable, and recordable.")
REAL=$(epic "Typing realism"             3 "Make replay read more like a person at a keyboard.")
FILT=$(epic "Filtering"                  3 "Make it easy to watch exactly the files you care about.")

# ---------------------------------------------------------------- hardening
CI=$(issue  "$HARD" chore 1 "CI pipeline running unit and integration tests" "GitHub Actions: npm test plus npm run it under xvfb, package the vsix as an artifact.")
issue "$HARD" bug  1 "ignoreOwnSaves misclassifies edits saved through the Claude Code VS Code extension" "Saves that come through VS Code buffers look like the user's own. Investigate a better signal than onDidSaveTextDocument timing." >/dev/null
issue "$HARD" bug  2 "Preserve original line endings in replay" "Replay normalizes to LF. Keep CRLF files as CRLF in the mirror document." >/dev/null
issue "$HARD" task 2 "Verify behavior on Windows" "Paths, watcher event patterns, and atomic-write rename behavior on Windows." >/dev/null
issue "$HARD" task 3 "Lift or stream the 5000-file baseline cap" "Snapshot lazily or stream baselines so large repos do not miss first changes." >/dev/null

# ---------------------------------------------------------------- context
HOOK=$(feature "$CTX" 1 "Capture changes from a Claude Code PostToolUse hook" "Optional capture path: a hook posts tool name, file, and tool_use_id so each change is attributed to an exact tool call. Disk watching stays the default.")
TRANS=$(feature "$CTX" 1 "Correlate changes with the Claude Code transcript" "Read the session JSONL to find the prompt and tool call behind each recorded change.")
CAPS=$(feature "$CTX" 2 "Show agent narration as captions during playback" "Display the agent's explanation text near the replay editor while its change is typed.")
CHAP=$(feature "$CTX" 2 "Group the timeline into chapters" "Split events by agent turn (from transcript) or by idle gaps (fallback).")
blocks "$TRANS" "$CAPS"
blocks "$TRANS" "$CHAP"

# ---------------------------------------------------------------- sessions
PERSIST=$(feature "$SESS" 2 "Persist the buffer across VS Code reloads" "Store the timeline in workspace storage so a reload does not lose history.")
SAVE=$(feature "$SESS" 2 "Save and load sessions to a file" "Export the timeline to a portable file and load it later for demos or review.")
GIT=$(feature "$SESS" 3 "Replay a git commit range or PR as typing" "Build a timeline from git history: one event per file per commit.")
blocks "$PERSIST" "$SAVE"
blocks "$SAVE" "$GIT"

# ---------------------------------------------------------------- presentation
SCRUB=$(feature "$PRES" 2 "Timeline scrubber panel" "Webview with play, pause, seek, and speed. Replaces most title-bar buttons.")
PRESENT=$(feature "$PRES" 3 "Presenter mode with GIF and MP4 export" "Hide VS Code chrome during playback and export recordings.")
feature "$PRES" 3 "Opt-in mode that types into the real editor tab" "For demos where the mirror tab is confusing. Must never leave the real file dirty or diverged." >/dev/null
feature "$PRES" 3 "Separate lanes for multiple agents or worktrees" "Color and group events by source when several agents run at once." >/dev/null
blocks "$SCRUB" "$PRESENT"
blocks "$SAVE" "$PRESENT"

# ---------------------------------------------------------------- realism
feature "$REAL" 3 "Occasional typos that get corrected" "Inject plausible mistakes and backspace them. Final text must still match exactly." >/dev/null
feature "$REAL" 3 "Simulated navigation to each edit" "Scroll and arrow toward the edit instead of jumping." >/dev/null
feature "$REAL" 4 "Natural authoring order" "Type signatures before bodies, closing braces early, and similar human patterns." >/dev/null
feature "$REAL" 4 "Typing sounds" "Optional keyboard audio during playback." >/dev/null
feature "$REAL" 4 "Per-language typing speed profiles" "Different base speeds per language id." >/dev/null

# ---------------------------------------------------------------- filtering
feature "$FILT" 1 "Repo persisted settings and filters" "Saves settings and filters in a JSON or YAML that can be commited to the repo." >/dev/null
feature "$FILT" 2 "Detect renames instead of delete plus create" "Pair a delete and create with matching content inside the debounce window." >/dev/null
feature "$FILT" 3 "Respect .gitignore" "Optionally treat gitignored paths as excluded." >/dev/null
feature "$FILT" 3 "Named filter profiles" "Save and switch filter sets, for example backend-only or docs-only." >/dev/null

echo "Seeded. Try: bd ready   |   bd list --type epic   |   bd show $CTX"
