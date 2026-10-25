---
title: Limits
description: "What Agent Typewriter does not do."
---

- Text files only. Binary files and files over `maxFileSizeKB` are skipped.
- The replay is a reconstruction, not a recording. It shows each change as a person would plausibly type it, not the agent's literal edit sequence (which is always an atomic write anyway).
- Every matching file needs a baseline for its first change to replay. In a git repository with git installed, clean tracked files use git as their baseline and cost no memory (`gitBaselines`). Other files are kept in memory up to `baselineBudgetMB`, newest first. A file left out starts recording from its second change, and the **Agent Typewriter** output channel says how many files that is.
- A rename is only detected while its first half is still held for reordering; a delete and a create further apart replay separately.

