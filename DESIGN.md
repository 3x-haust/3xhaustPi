# 3xhaustPi Native TUI Design System

## 0. Research Log

3xhaustPi is an existing terminal product being redesigned from verified public
coding-harness patterns rather than copied from one brand.

- **OMP / oh-my-pi:** bounded model overlays, composable status segments,
  deterministic transcript grouping, expandable tool output, agent roster, and
  ANSI/CJK width as a component contract.
- **GJC / gajae-code:** explicit pending/done/error tool states, bounded
  expansion with honest truncation, dedicated task surfaces, and ANSI-preserving
  narrow/medium/wide visual QA.
- **OmO beta / Senpi:** semantic modes, visible orchestration, named specialist
  activity, and short commands that activate substantial workflows.
- **OpenAI Codex CLI:** composer-first shell, structured execution cells,
  focused overlays, persistent compact status, and explicit resize/reflow
  architecture.
- **OpenCode:** strongest progressive disclosure policy; hide low-priority
  footer segments before core model, context, and activity state.
- **Crush:** searchable command palette, model/session discoverability,
  permission visibility, and compact mode.
- **Aider:** transcript-first readability, operational controls kept behind
  commands, token/context detail on demand, and strong keyboard conventions.
- **Gemini CLI / Claude Code / Goose / Plandex:** discoverable tools and context,
  customizable status, provider/extension health, and durable plan/session
  state.
- **Linear reference:** precision, restrained accent color, hierarchy through
  luminance rather than decoration, and keyboard-first operational density.
- **StyleGallery contracts:** `scroll-body-shell` owns vertical transcript
  scrolling; `feed` gives semantic transcript rhythm; `cluster` governs
  independently hideable status segments; `imposter` describes bounded focused
  pickers without displacing the shell.
- **Baseline audit:** the old shell duplicated the project name, exposed a
  static help row at every width, used unrelated width/height constants, and
  allowed static/live layout drift. The transcript was safe but visually flat,
  and tool/agent events read as an undifferentiated system log.
- **Skipped:** browser-only lazyweb and Lighthouse workflows do not represent a
  native terminal surface. Real PTY captures and ANSI/CJK review replace them.

## 1. Atmosphere & Identity

3xhaustPi should feel like a quiet, precise instrument: native to the terminal,
fast to scan, and calm under heavy agent activity. It is neither a dashboard
made of boxes nor a decorative chatbot.

- Product identity: `3xhaustPi`
- Voice: concise, direct, operational
- Signature: a cool blue-violet accent used sparingly for focus and active work
- Hierarchy: text luminance first, semantic color second, separators last
- Shape language: rules, rails, and compact cells; no ornamental box soup
- Density: transcript-first with progressive disclosure at narrow widths

## 2. Color

### Palette

| Token | ANSI 256 | Role |
| --- | ---: | --- |
| `accent` | 111 | focus, active model, assistant identity |
| `text-primary` | 255 | user content and essential labels |
| `text-secondary` | 250 | metadata that remains readable |
| `text-muted` | 245 | secondary hints and inactive segments |
| `text-ghost` | 239 | separators and lowest-priority structure |
| `success` | 114 | completed state |
| `warning` | 214 | approval and paused state |
| `failure` | 203 | failed state |
| `info` | 117 | informational and pending state |
| `disabled` | 242 | unavailable controls and missing metadata |
| `path` | 150 | file paths and navigable resources |
| `diff-add` | 114 | added diff lines |
| `diff-remove` | 203 | removed diff lines |
| `selection` | reverse video | focused picker row |

### Rules

- Color never carries state alone; every state also has a symbol or word.
- The accent appears in at most one dominant location per row.
- Transcript prose stays primary/secondary neutral for long-read comfort.
- Separators are always lower contrast than the content they organize.
- ANSI resets must survive clipping and wrapping.
- `NO_COLOR` and monochrome terminals retain the same symbols, labels, rails,
  and reverse-video selection; only semantic hues disappear.
- On 16-color terminals, accent/info map to cyan, success/diff-add to green,
  warning to yellow, and failure/diff-remove to red.
- Focus uses reverse video plus a leading marker; active-but-unfocused state
  uses accent text without reverse video.

## 3. Typography

### Scale

The terminal font is user-controlled. Hierarchy uses weight-by-luminance,
symbols, casing, and spacing rather than font-size changes.

| Level | Treatment | Use |
| --- | --- | --- |
| Product | bright label plus subtle accent mark | shell identity |
| Primary | `text-primary` | user and assistant content |
| Secondary | `text-secondary` | model, project, command labels |
| Metadata | `text-muted` | duration, context, provider, hints |
| Structural | `text-ghost` | rails, dividers, continuation marks |

### Font Stack

The active terminal monospace font. All width decisions use terminal cell
width, never JavaScript string length.

### Rules

- Preserve grapheme clusters, CJK double-width cells, emoji, combining marks,
  tabs, and ANSI sequences.
- Avoid all-caps labels except compact machine states.
- Keep labels short enough to remain intact at 56 columns.
- Wrap prose; truncate low-priority metadata; never split command tokens.

## 4. Spacing & Layout

### Base Unit

One terminal cell horizontally and one terminal row vertically.

### Grid

The root follows StyleGallery `scroll-body-shell`:

1. **Identity rail:** fixed, one row.
2. **Context rail:** optional, one row in roomy modes.
3. **Transcript:** owns all remaining vertical space and scrolls/reflows.
4. **Activity/composer:** fixed; autocomplete reserves its own bounded rows.
5. **Status rail:** fixed, one row with width-prioritized segments.

### Responsive Modes

| Mode | Width | Policy |
| --- | ---: | --- |
| `degraded` | `< 40` or `< 10 rows` | bounded identity, composer, status, and a terminal-size notice |
| `minimal` | `40–55` | identity + activity, no persistent hints, compact footer |
| `compact` | `56–79` | project, model, context percent, activity; short hint |
| `full` | `80–119` | provider/model, context, git, tasks, command hint |
| `wide` | `>= 120` | full status segments and richer activity metadata |

Height is also a first-class constraint:

- Optional context/help rows collapse before transcript, composer, or status.
- Autocomplete rows are subtracted from transcript budget.
- Physical terminal width and height are hard limits; no synthetic minimum may
  emit outside them.
- Transcript may fall to one row only when essential fixed chrome consumes the
  rest.
- Supported physical floor is `20x8`. Below it, emit at most the physical rows
  and columns with `3xhaustPi · terminal too small`, `/exit`, and no picker.
- Validation matrix: `20x8`, `32x10`, `40x12`, `56x22`, `72x24`, `80x24`,
  and `120x32`.

### Rules

- The transcript is the sole vertical scroll owner.
- Header, composer, active state, and status remain visible during interaction.
- Status segments are independent `cluster` items with explicit priority.
- Empty space is intentional breathing room, not filled with permanent panels.
- A focused picker is bounded to at most 40% of terminal height.

### Shared Layout Contract

One pure layout function owns static and live rendering. Given physical columns,
rows, editor rows, and overlay rows, it returns:

- density mode
- visible rail set
- exact chrome row count
- transcript row budget
- segment variants selected for each rail
- degraded-state decision

No renderer may invent a separate width floor, height floor, footer candidate,
or transcript budget.

### Responsive Segment Table

| Segment | Home | Priority | Ideal | Compact | Minimum / hide rule |
| --- | --- | ---: | --- | --- | --- |
| product | identity | 100 | `3xhaustPi` | `3xhaustPi` | never hide |
| workspace | identity | 90 | project basename | clipped from left | hide only in degraded mode |
| activity | activity | 100 | symbol + verb + target | symbol + verb | never hide while non-ready |
| approval keys | activity | 100 | `y apply · n reject` | `y/n` | never hide during review |
| model | status | 95 | provider/model + thinking | model | clip model tail only after provider hides |
| context | status | 85 | used/limit + percent | percent | hide when unavailable or below 40 columns |
| git | status | 65 | branch/status | status glyph | hide before model/context |
| tasks/queue | status | 60 | named counts | combined count | hide when both zero |
| provider health | status | 55 | provider + health | health glyph | hide before model |
| shortcuts | context | 20 | four commands | `/help · /model` | hide before wrapping |

Segments resolve by priority and measured cell width. A lower-priority segment
disappears before a higher-priority segment truncates.

Resolution algorithm:

1. Measure the physical row budget including three-cell separators (` · `).
2. Sort candidate segments by descending priority.
3. Greedily admit each segment in its compact form only when it fits with its
   separator; a lower-priority segment is never admitted while a higher-priority
   candidate is missing.
4. Promote admitted segments from compact to ideal in descending priority while
   cells remain.
5. If the highest-priority model compact form still does not fit, render one
   atomic middle-ellipsized token with at least four visible cells. Pickers and
   command output always show the complete token.
6. Never leave a leading/trailing separator and never budget ANSI bytes as
   visible cells.

## 5. Components

### Identity Rail

- One product label only: no duplicated `3xhaustPi` project name.
- Owns only product and workspace identity.
- Full/compact: `3xhaustPi  ·  project`
- Minimal: `3xhaustPi`
- Model and run state never repeat here.

### Context Rail

- Optional one-row shortcut/hint surface.
- Shows only high-frequency actions: `/help`, `/model`, `/resume`, `/exit`.
- Hidden before it wraps or competes with transcript space.

### Transcript Feed

- Semantic roles: `you`, `threeXhaust`, `tool`, `agent`, `system`.
- User and assistant messages are unmistakable conversation turns: a standalone
  speaker header, an indented prose body, and one blank row separating turns.
  They never share the compact execution-log row template.
- User and assistant prose owns the widest measure in the transcript. Repeated
  side rails are forbidden because they make wrapped conversation read as a
  diagnostic table.
- System messages are quieter than conversation and have no repeated `system`
  label. A compact notice marker may introduce durable notices, but startup,
  restored-queue counts, resumable-session state, and transient progress belong
  to activity/status rather than the chat transcript.
- Consecutive tool events group under a tool/capability identity.
- Completed tool rows show state, name, duration, and summary.
- Raw output emitted into the transcript is bounded and exposes omitted-line
  counts. Interactive expansion is not part of this redesign.
- Newest content remains visible; persisted order stays deterministic.

#### Execution Spine

3xhaustPi's distinctive grammar is a restrained execution spine connecting one
assistant turn to its host work:

```text
3xhaust │ I’ll inspect the failing path.
       ├ tool  read src/auth.ts                 running
       ├ tool  test auth.test.ts              ✓ 184 ms
       ├ agent luna  login flow               ◇ working
       └ result  Root cause confirmed
```

- `│`, `├`, and `└` encode ownership without drawing boxes.
- Parallel siblings share the same spine level.
- Duration aligns after the state when space permits and moves to the next
  metadata row only in wide mode.
- Durable results enter the transcript; transient progress remains in activity.

#### Row Templates

| Event | Durable transcript form |
| --- | --- |
| user message | standalone `You` header followed by indented prose |
| assistant streaming | standalone `3xhaust` header followed by partial prose updated in place |
| assistant complete | standalone `3xhaust` header followed by indented prose |
| tool pending/running | child spine row with explicit verb and `pending`/`running` |
| tool success | child spine row with `✓`, duration, concise summary |
| tool failure | child spine row with `×`, duration, error summary |
| tool cancelled | child spine row with `– cancelled` |
| tool truncated | result row plus `… N lines omitted` |
| agent queued/active | child spine row with role/name and state word |
| agent blocked/failed | child spine row with warning/failure symbol and reason |
| approval | child spine row naming the originating patch/tool and accepted keys |
| system notice | low-contrast `· message`, only for durable user-relevant notices |
| error | `error │ message` with failure symbol |

Tool rows show state, capability, key argument, duration, and summary. Attached
output is capped at 100 lines and ends with an omitted-line count. Approval
always stays attached to the originating execution row.

#### Scroll Contract

- Follow-tail is the default.
- With an empty composer and no picker, `PageUp`/`PageDown` move by one
  transcript viewport and `Alt+Up`/`Alt+Down` move one transcript row.
- `Alt+End` returns to latest output.
- When output arrives while detached, preserve scroll position and show
  `↓ N new` in the activity row.
- Submitting a new user message returns to follow-tail.
- Copy/selection remains terminal-native and never forces follow-tail.
- Picker input always wins. A non-empty or multiline composer always wins over
  transcript navigation. No global transcript key consumes an editor key while
  the editor has content.

### Activity Row

- Lives immediately above the composer.
- Owns current ephemeral execution state; no other rail repeats it.
- Ready: visible prompt affordance and command discovery.
- Running: explicit verb plus capability, never spinner-only.
- Review: approval action and key choices.
- Queued: count remains visible without flooding the transcript.
- Detached scroll: new-output count and return-to-latest key.

#### Concurrent Activity Arbitration

The single row resolves simultaneous state in this order:

1. approval/review request
2. foreground failure or cancellation event
3. current foreground capability
4. active agents/tools aggregate
5. queued follow-ups
6. ready

Within one priority, show the latest foreground target. If more than one sibling
is active, prefix the latest target with the total, for example
`3 active · searchText`. A completion immediately selects the next active
sibling; it never leaves a stale target.

### Composer

- Always visually focused with a leading `›`.
- Empty state says what can be done, not how the UI was implemented.
- `/` opens command discovery; command and model tokens remain intact.
- Editor borders use low-contrast rules and never consume decorative side rails.

### Command / Model Picker

- Uses Pi's existing `showOverlay()` compositor and follows the `imposter`
  contract; it does not consume transcript rows.
- Searchable, keyboard-first, active selection obvious.
- Keeps transcript, identity, composer, and footer stable.
- Model changes are visibly session-scoped.
- Captures focus while open; `Escape` restores composer focus.
- Maximum width is `min(76, terminal - 4)` and maximum height is 40% of terminal
  rows. At degraded dimensions it falls back to compact in-flow results.

### Status Rail

Segment priority, highest first:

1. model
2. context utilization
3. git/provider health
4. active tasks/queue

Low-priority segments disappear instead of clipping core labels.

### State Ownership Matrix

| Runtime state | Transcript | Activity | Composer | Status | Accepted keys / transition |
| --- | --- | --- | --- | --- | --- |
| ready | none | `ready` affordance | enabled | persistent telemetry | text submits; `/` opens picker |
| waiting for model | session row once | `waiting for model` | queue enabled | model visible | `Ctrl+C` cancels wait |
| assistant streaming | in-place assistant row | `writing response` | queue enabled | context updates on event | `Ctrl+C` preserves partial output |
| tool running | execution-spine child | verb + capability | queue enabled | task count increments | `Ctrl+C` cancels active run |
| agent active | execution-spine child | agent name + current action | queue enabled | agent count | durable spine row only |
| approval requested | attached approval row | explicit subject + keys | disabled | warning health | `y` approve, `n` reject, `Esc` reject |
| queued follow-up | durable user queue row | queued count | enabled | queue count | `/queue`, `/clear` |
| cancelled | cancellation result row | `cancelled` then ready | enabled | task count decrements | next input |
| failed | error/result row | concise failure then ready | enabled | failure health until next run | `/resume` when available |
| interrupted/resumable | system row | `resume available` | enabled | session health warning | `/resume` |
| provider unavailable | system/error row | explicit provider issue | enabled for commands | provider failure | `/model`, `/accounts` |
| context warning/critical | no duplicate prose | warning in activity only at critical | enabled | context warning token | `/new`, `/clear` |
| no models/no matches | picker empty state | unchanged | picker owns input | unchanged | edit query or `Esc` |
| transcript detached | durable feed unchanged | `↓ N new · Alt+End latest` | enabled | unchanged | transcript keys only when composer empty |

An event has one primary surface. Durable facts go to the transcript; ephemeral
work goes to activity; environment telemetry goes to status.

The `agent active` transition exposes no dedicated detail picker in this
redesign; the durable execution-spine row is the only agent detail surface.

## 6. Motion & Interaction

### Timing

Terminal rendering is event-driven; no decorative animation is introduced.

### Rules

- Differential redraws must not scroll fixed chrome.
- Running work may use a subtle changing glyph only alongside a text state.
- Completed, failed, and approval states update immediately on exact events.
- First `Ctrl+C` during active work cancels it and preserves the session/UI.
- Idle `Ctrl+C` clears non-empty composer input; a second idle `Ctrl+C` on an
  empty composer exits. The exit arm is consecutive-key state, not a timer: any
  non-`Ctrl+C` input disarms it. `/exit` always performs deterministic shutdown.
- `Escape` closes a picker or rejects the currently focused transient surface;
  it never silently exits.
- Composer owns default focus. Pickers temporarily capture focus and restore it
  on dismissal. Transcript navigation is global and does not become a fake
  focusable control.
- Streaming and partial output remain readable after cancellation.
- Cancellation and failure have no timed acknowledgement. Their durable row is
  appended synchronously, then activity transitions to `ready` in the same
  completion/failure event after active handles clear.

### Execution Spine Width Rules

- Wide/full: state, capability, key argument, duration, and summary may share
  one row when measured cells fit.
- Compact: preserve state + capability; key argument is one atomic
  middle-ellipsized token; duration and summary disappear in that order.
- Minimal: render only spine glyph, state symbol/word, and capability.
- Degraded: flatten to `state capability` without nested rails.
- Continuation prose aligns beneath the content after the spine; nesting never
  exceeds one visible rail at compact/minimal widths.
- Agent names and capability names are atomic. If either exceeds its budget,
  middle-ellipsize it rather than wrapping inside the token.
- Summaries wrap only in full/wide modes and remain CJK/ANSI cell-safe.

## 7. Depth & Surface

### Strategy

Depth comes from luminance and containment, not nested boxes:

- primary shell: terminal background
- transcript roles: label/rail hierarchy
- active picker: bounded higher-contrast surface
- approval/error: semantic accent plus explicit text
- separators: one-cell ghost rules

No gradients, shadows, rounded-card imitation, or decorative emoji clusters.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Every rendered line fits its physical terminal width.
- Every live root layout fits terminal height at tested sizes.
- CJK, emoji, combining characters, ANSI, and unbroken strings remain safe.
- State is conveyed by text/symbol as well as color.
- Essential controls remain visible at 56x22, 72x24, and 120x32.
- Narrow mode preserves model/activity access through commands even when
  persistent metadata is hidden.
- Command tokens and key hints never wrap mid-token.
- Keyboard-only use is complete; no mouse-only action exists.
- Visual QA uses true PTY screen state, not flattened differential logs.

### Critical Screen Specifications

1. **Idle:** identity, empty conversation canvas, ready or resumable activity,
   focused composer, model/context status. “Workspace ready” is not chat.
2. **Streaming:** partial assistant row in transcript, explicit writing state,
   composer still available for durable queueing.
3. **Parallel work:** one execution spine with tool/agent siblings and explicit
   states; no repeated full-card boxes.
4. **Approval:** originating execution row plus attached approval, activity owns
   `y/n` keys, composer disabled.
5. **Failure:** failed child/result remains durable; activity returns to ready
   after concise acknowledgement.
6. **Detached transcript:** content position is stable; `↓ N new` is visible.
7. **Command/model picker:** bounded overlay, active row in reverse video,
   shell remains visible.
8. **Compact/minimal:** optional context rail disappears, footer retains model
   before context/git/task metadata.
9. **Degraded:** bounded terminal-size notice, composer, and exit path only.

### Accepted Debt

- Interactive tool-result expansion, transcript search, and a dedicated
  agent/task pane require additional interaction state. This redesign provides
  bounded durable rows and scrolling only; it must not expose controls for
  expansion, search, or agent detail that are not implemented.
- Terminal themes vary. The ANSI-256 palette assumes a dark or neutral terminal
  and is validated for contrast through luminance hierarchy rather than exact
  background ownership.
