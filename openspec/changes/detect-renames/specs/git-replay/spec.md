## MODIFIED Requirements

### Requirement: Change kinds and paths
A file added by a replayed commit SHALL be a create, a removed file a delete, a file git detects as renamed (at its default similarity) a rename, and any other changed file a modify. Only files inside the workspace folder SHALL be replayed, and each SHALL replay into the same mirror document as a recorded change to that file in the folder's own checkout (with the folder's label in front of the path in a multi-root workspace). A rename whose old or new path the filters leave out SHALL replay as a create of the new path or a delete of the old one. A rename without a content change SHALL still be replayed.

#### Scenario: Folder below the repository top
- **WHEN** the workspace folder is `repo/pkg` and a replayed commit changes `repo/pkg/src/a.ts` and `repo/README.md`
- **THEN** the buffer holds one change, to `src/a.ts`

#### Scenario: Multi-root workspace
- **WHEN** folders `api` and `web` are open and the user replays a commit in `api` that changes `src/a.ts`
- **THEN** the change plays into the mirror named `api/src/a.ts`, the same one a recorded change to that file uses

#### Scenario: Renamed file
- **WHEN** a replayed commit runs `git mv src/a.ts src/b.ts`
- **THEN** the buffer holds one rename from `src/a.ts` to `src/b.ts`
