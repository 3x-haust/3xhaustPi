# 3xhaustPi Native TUI Design System

## 1. Atmosphere & Identity

3xhaustPi should feel like a quiet, precise instrument: native to the terminal,
fast to scan, and calm under heavy agent activity. It is neither a dashboard
made of boxes nor a decorative chatbot.

- Product identity: `3xhaustPi`
- Voice: concise, direct, operational
- Signature: a cool blue-violet accent used sparingly for focus and active work
- Hierarchy: prompt surface first, text luminance second, semantic color last
- Shape language: full-width prompt bands, open prose, and one composer rule
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
| `prompt-surface` | 238 | full-width submitted user prompt band |
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

The root uses one vertical shell:

1. **Context title:** fixed, one quiet row.
2. **Transcript:** owns all remaining vertical space and scrolls/reflows.
3. **Activity:** fixed, one row.
4. **Composer:** fixed, one rule plus the `>` input row; autocomplete reserves
   its own bounded rows.

### Responsive Modes

| Mode | Width | Policy |
| --- | ---: | --- |
| `degraded` | `< 40` or `< 10 rows` | bounded title, transcript, activity, and composer |
| `minimal` | `40–55` | one-row prompt bands, unlabeled answer, activity |
| `compact` | `56–79` | tinted prompt bands, answer flow, activity |
| `full` | `80–119` | wider answer measure and response metrics |
| `wide` | `>= 120` | three-row prompt bands and complete response metrics |

Height is also a first-class constraint:

- Optional response metadata collapses before transcript, activity, or composer.
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
- Context title, composer, and active state remain visible during interaction.
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

### Responsive Surface Table

| Surface | Wide/full | Compact | Minimal/degraded |
| --- | --- | --- | --- |
| title | product, project, model | product and project | product |
| user prompt | empty tint row, content, empty tint row | content plus one tint row | content row only |
| thought | duration and work summary | duration | hide before answer |
| answer | readable capped measure | terminal measure | terminal measure |
| metrics | throughput, cache, duration | cache and duration | duration |
| activity | state, target, interrupt key | state and target | state |
| composer | top rule plus `>` input | same | same |

## 5. Components

### Identity Rail

- One product label only: no duplicated `3xhaustPi` project name.
- Owns only product and workspace identity.
- Full/compact: `3xhaustPi  ·  project`
- Minimal: `3xhaustPi`
- Model and run state never repeat here.

### Transcript Feed

- Semantic roles: `prompt`, `thought`, `work`, `answer`, `metrics`, `system`.
- Submitted prompts are full-width `prompt-surface` bands. The surface, not a
  speaker name, identifies the user role. `You`, `User`, `3xhaust`, and generic
  assistant labels never render.
- Wide prompt bands use an empty surface row above and below the prompt.
  Compact bands retain the same tint while dropping empty rows before content.
- Assistant output is open prose on the terminal background. Its sequence is
  muted italic thought timing, emphasized work summary when available, bright
  answer prose, then subdued response metrics.
- Answer prose owns the widest readable measure. Repeated labels, side rails,
  and chat bubbles are forbidden.
- System messages are quieter than conversation and have no repeated `system`
  label. A compact notice marker may introduce durable notices, but startup,
  restored-queue counts, resumable-session state, and transient progress belong
  to activity/status rather than the chat transcript.
- Completed work rows show state, capability, duration, and summary without an
  assistant header or execution-tree rail.
- Raw output emitted into the transcript is bounded and exposes omitted-line
  counts. Interactive expansion is not part of this redesign.
- Newest content remains visible; persisted order stays deterministic.

#### Response Flow

3xhaustPi's transcript grammar is:

```text
[full-width tinted user prompt]

Thought: 1.2s
Planning the response

Bright assistant answer with no speaker label.

TPS 15.8 tok/s · Cache hit 0.0% · 4.5s
```

- Prompt tint is the only large-area surface in the transcript.
- Thought and metrics are visibly quieter than the answer.
- Durable work results may appear between thought and answer; transient progress
  stays in the activity row.

#### Row Templates

| Event | Durable transcript form |
| --- | --- |
| user message | full-width tinted prompt band, no speaker label |
| model completed | muted italic `Thought: <duration>` |
| assistant streaming | bright unlabeled partial prose updated in place |
| assistant complete | bright unlabeled prose followed by metrics |
| tool pending/running | muted work row with explicit verb and state |
| tool success | muted `✓ capability · duration · summary` |
| tool failure | failure `× capability · duration · summary` |
| tool cancelled | muted `– cancelled` |
| tool truncated | result row plus `… N lines omitted` |
| agent queued/active | emphasized work summary without a role rail |
| agent blocked/failed | warning/failure summary |
| approval | review row naming the originating patch/tool and accepted keys |
| system notice | low-contrast `· message`, only for durable user-relevant notices |
| error | `error │ message` with failure symbol |

Work rows show state, capability, key argument, duration, and summary. Attached
output is capped at 100 lines and ends with an omitted-line count.

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
- Ready: quiet `• Ready`; command discovery stays behind `/help`.
- Running: `• Working (<detail> · esc to interrupt)`, never spinner-only.
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

Within one priority, show the latest foreground target. A completion immediately
selects the next active sibling; it never leaves a stale target.

### Composer

- Always visually focused with a leading `>`.
- Empty state is an unlabeled hardware cursor, matching a native shell prompt.
- `/` opens command discovery; command and model tokens remain intact.
- A single accent-tinted top rule separates the composer. There is no bottom
  border and no decorative side rail.

### Command / Model Picker

- Uses the existing `showOverlay()` compositor with a bounded overlay contract;
  it does not consume transcript rows.
- Searchable, keyboard-first, active selection obvious.
- Keeps transcript, context title, and composer stable.
- Model changes are visibly session-scoped.
- Captures focus while open; `Escape` restores composer focus.
- Maximum width is `min(76, terminal - 4)` and maximum height is 40% of terminal
  rows. At degraded dimensions it falls back to compact in-flow results.

### Response Metrics

- Metrics follow the answer instead of occupying a permanent footer.
- Full/wide: throughput, cache-hit ratio, and duration when measured.
- Compact: cache-hit ratio and duration.
- Minimal/degraded: duration only.
- Missing measurements disappear; the UI never invents telemetry.

### State Ownership Matrix

| Runtime state | Transcript | Activity | Composer | Status | Accepted keys / transition |
| --- | --- | --- | --- | --- | --- |
| ready | none | `• Ready` | enabled | none | text submits; `/` opens picker |
| waiting for model | thought row when measured | `• Working` | queue enabled | none | `Ctrl+C` cancels wait |
| assistant streaming | unlabeled answer row | `• Working` | queue enabled | metrics follow answer | `Ctrl+C` preserves partial output |
| tool running | muted work row | verb + capability | queue enabled | none | `Ctrl+C` cancels active run |
| agent active | emphasized work row | agent action | queue enabled | none | durable work row only |
| approval requested | attached approval row | explicit subject + keys | disabled | warning health | `y` approve, `n` reject, `Esc` reject |
| queued follow-up | no duplicate transcript row | queued count | enabled | none | `/queue`, `/clear` |
| cancelled | cancellation result row | cancelled then ready | enabled | none | next input |
| failed | error/result row | concise failure then ready | enabled | none | `/resume` when available |
| interrupted/resumable | system row | resume available | enabled | none | `/resume` |
| provider unavailable | system/error row | explicit provider issue | enabled for commands | none | `/model`, `/accounts` |
| context warning/critical | no duplicate prose | warning in activity only at critical | enabled | none | `/new`, `/clear` |
| no models/no matches | picker empty state | unchanged | picker owns input | none | edit query or `Esc` |
| transcript detached | durable feed unchanged | `↓ N new · Alt+End latest` | enabled | none | transcript keys only when composer empty |

An event has one primary surface. Durable facts and measured response telemetry
go to the transcript; ephemeral work goes to activity.

The `agent active` transition exposes no dedicated detail picker in this
redesign; the durable work row is the only agent detail surface.

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

### Response Width Rules

- Wide/full: prompt bands span the terminal; answer prose remains capped to a
  readable measure; complete response metrics may share one row.
- Compact: prompt tint remains full width; metrics drop throughput before
  wrapping.
- Minimal: prompt band keeps content only; answer remains unlabeled.
- Degraded: prompt tint may flatten to one row but roles remain distinguishable.
- Continuation prose aligns to the answer gutter without a role label.
- Capability names remain atomic and middle-ellipsize before wrapping.
- Work summaries wrap only in full/wide modes and remain CJK/ANSI cell-safe.

## 7. Depth & Surface

### Strategy

Depth comes from luminance and containment, not nested boxes:

- primary shell: terminal background
- submitted prompts: one full-width slate surface
- assistant flow: luminance hierarchy on the terminal background
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

1. **Idle:** context title, empty transcript, ready or resumable activity, and
   focused `>` composer. “Workspace ready” is not chat.
2. **Streaming:** partial unlabeled assistant prose, explicit working state, and
   composer still available for durable queueing.
3. **Parallel work:** restrained work rows with explicit states; no role labels,
   execution tree, or repeated full-card boxes.
4. **Approval:** originating execution row plus attached approval, activity owns
   `y/n` keys, composer disabled.
5. **Failure:** failed child/result remains durable; activity returns to ready
   after concise acknowledgement.
6. **Detached transcript:** content position is stable; `↓ N new` is visible.
7. **Command/model picker:** bounded overlay, active row in reverse video,
   shell remains visible.
8. **Compact/minimal:** prompt tint and unlabeled answer remain; optional
   metrics disappear before content.
9. **Degraded:** bounded context title, prompt surface, composer, and exit path.

### Accepted Debt

- Interactive tool-result expansion, transcript search, and a dedicated
  agent/task pane require additional interaction state. This redesign provides
  bounded durable rows and scrolling only; it must not expose controls for
  expansion, search, or agent detail that are not implemented.
- Terminal themes vary. The ANSI-256 palette assumes a dark or neutral terminal
  and is validated for contrast through luminance hierarchy rather than exact
  background ownership.
