# Spec Delta

## Purpose

Defines the order in which replay types the text of a change, so new code appears the way a person writes it, such as closing a block before filling it in, rather than strictly top to bottom.

## ADDED Requirements

### Requirement: Blocks are typed outside in
With `agentTypewriter.naturalOrder` on, when one edit types a whole block, replay SHALL type its opening line, then its closing line, then the lines between. A block opens with a `{`, `[` or `(` that ends a line. It closes at the first later non-blank line not indented deeper than the opening line, when that line has the same indentation and starts with the matching bracket.

#### Scenario: New function
- **WHEN** a change adds `function f() {`, `  return 1;` and `}` as three new lines
- **THEN** replay types `function f() {`, then the line `}` below it, then `  return 1;` between them

#### Scenario: Closing line keeps the rest of its line
- **WHEN** a change adds `const o = {`, `  a: 1,` and `};`
- **THEN** the line `};` is typed whole right after `const o = {`, before `  a: 1,`

#### Scenario: Empty block
- **WHEN** a change adds `{` followed directly by `}` on the next line
- **THEN** both lines are typed top to bottom

#### Scenario: Closing bracket that does not match
- **WHEN** a line ending in `(` is followed by deeper-indented lines and then a line at its indentation starting with `]`
- **THEN** those lines are typed top to bottom

#### Scenario: Line at the same indentation before any closer
- **WHEN** a line ending in `{` is followed by a line at the same indentation that does not start with `}`, as in a `switch` whose `case` labels are not indented
- **THEN** that `{` opens no block and its lines are typed top to bottom

#### Scenario: Block only partly in the edit
- **WHEN** a change adds lines to the body of an existing function, without its opening or closing line
- **THEN** the added lines are typed top to bottom

### Requirement: Nested blocks
Blocks inside a block's body SHALL each be typed outside in when replay reaches them. After a block's body, replay SHALL carry on with what follows the block's closing line before typing anything after it.

#### Scenario: If inside a function
- **WHEN** a change adds a function whose body holds an `if (x) {` block
- **THEN** the function's `}` is typed before its body, and the `if` block's `}` is typed right after `if (x) {`, before that block's body

#### Scenario: Two blocks in a row
- **WHEN** a change adds two functions one after the other
- **THEN** the first function's opening line, closing line and body are all typed before the second function's opening line

#### Scenario: Else branch
- **WHEN** a change adds `if (a) {`, `  x();`, `} else {`, `  y();` and `}`
- **THEN** replay types `if (a) {` and `}`, then `  x();`, then ` else {` after that `}` and the final `}` below it, then `  y();`

### Requirement: Header before body
A block's header SHALL be typed in full before its body, including any block inside the header, so a function's signature comes before its body even when its parameters span several lines.

#### Scenario: Parameters on several lines
- **WHEN** a change adds `function f(`, `  a,`, `  b,`, `) {`, `  return a + b;` and `}`
- **THEN** replay types `function f(` and `)`, then the parameter lines, then ` {` with the final `}` below it, then the `return` line

#### Scenario: Language without brackets for blocks
- **WHEN** a change adds a Python function `def f(a, b):` with an indented body
- **THEN** the lines are typed top to bottom, signature first

### Requirement: Order changes only within an edit
Natural order SHALL NOT change the order of a change's edits relative to each other, which stay top to bottom. When a change finishes playing, the mirror's text SHALL equal the change's after text, whatever the order. Single-line bracket pairs SHALL be typed left to right.

#### Scenario: Two edits far apart
- **WHEN** a change adds a function near the top of a file and edits a line near the bottom
- **THEN** the function, typed outside in, is finished before the edit near the bottom is typed

#### Scenario: Final text
- **WHEN** a change that adds nested blocks finishes playing
- **THEN** the mirror's text equals the change's after text

#### Scenario: Call on one line
- **WHEN** a change adds `print(total)`
- **THEN** it is typed left to right

### Requirement: Natural order setting
`agentTypewriter.naturalOrder` SHALL default to `true`, SHALL apply from the next change played without a reload, and SHALL be accepted in the repository settings file like other settings. With it set to `false`, replay SHALL type every edit top to bottom.

#### Scenario: Turned off
- **WHEN** `naturalOrder` is `false` and a change adds a function
- **THEN** the function is typed top to bottom, its `}` last

#### Scenario: Repository settings file
- **WHEN** the repository settings file sets `naturalOrder` to `false` and no workspace or user setting sets it
- **THEN** changes are typed top to bottom
