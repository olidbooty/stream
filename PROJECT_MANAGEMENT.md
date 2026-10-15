# Project management

How work on `stream` is planned and tracked, and how code changes map back to
the plan.

## Where things live

| What | Where |
| ---- | ----- |
| Project tracker (source of truth for steps, status and schedule) | [Torrent Streaming Project Tracker](https://docs.google.com/spreadsheets/d/1lwJskbvXaFX3hABsaq_NtmT3VclYJ7OXIsRmnb8Go9s/edit) (Google Sheets) |
| Original plan the tracker was built from | "Torrent Streaming Project Plan" in the same Google Drive. Kept for reference, not updated |
| Code, branches and pull requests | This repository |
| Setup and scripts | [README.md](README.md) |
| Test conventions | [TESTING.md](TESTING.md) |

The tracker is private to the project owner's Google account. Ask the owner for
access if the link doesn't open for you.

## The tracker

The spreadsheet has four tabs:

- **Dashboard**: progress per milestone and priority, the planned finish date,
  and counts of overdue and late steps. Every number is calculated, so nothing
  here needs editing.
- **Tracker**: one row per step. This is where all updates happen.
- **Timeline**: a weekly Gantt-style view of each step's planned dates. The
  current week is highlighted and finished steps are green. It mirrors the
  Tracker row for row.
- **Risks & Decisions**: open questions, the steps they affect, and the step
  each one must be decided before.

### Tracker columns

Yellow cells are inputs. Blue text marks assumptions you can change. Every
other cell is a formula, so don't type over it.

| Column | Type | Meaning |
| ------ | ---- | ------- |
| Step ID | input | `<milestone>.<n>`, e.g. `2.1`. Stored as text, so `1.10` stays distinct from `1.1` |
| Milestone | input | One of the milestones below; the Dashboard groups by this exact text |
| Step | input | What the step delivers |
| Status | input | `Not Started`, `In Progress`, `Blocked` or `Done` |
| Priority | input | `High`, `Medium` or `Low` |
| Depends On | input | Step ID this step waits for, or `None` |
| Ready? | formula | `Ready` once the dependency is `Done`, otherwise `Blocked`. `Complete` when the step itself is `Done` |
| Est. Days | input | Estimate in whole working days |
| Planned Start / Planned End | formula | See [Scheduling](#scheduling) |
| Schedule | formula | `Overdue` if not done after Planned End; once done, `On time` or `Late` against Planned End |
| Owner | input | Who is doing it |
| Actual Start / Completed Date | input | Dates the work actually started and finished |
| Technical Notes / Risks | input | Implementation notes. `NEW` marks steps added after the original plan |

The project start date is in cell `D3` of the Tracker tab.

### Scheduling

- Dates count working days only (Monday to Friday).
- A step with no dependency starts on the project start date.
- Any other step starts the working day after its dependency ends. If the
  dependency is `Done` and has a Completed Date, that date is used. Otherwise
  its Planned End is used.
- Planned End is Planned Start plus Est. Days, minus one.
- Steps that don't depend on each other are scheduled in parallel. One person
  working alone will in practice do them one after another, so treat the
  finish date as optimistic.

So when you mark a step `Done` with its real Completed Date, everything that
depends on it moves earlier or later to match.

## Milestones

| Milestone | Steps | Covers |
| --------- | ----- | ------ |
| M1 - Setup: project skeleton | 1.1–1.3 | npm workspace, Express and WebTorrent, static file server |
| M2 - Setup: frontend, network & testing | 1.4–1.10 | Vite, LAN access, Vitest, smoke tests, WebTorrent mock, TypeScript migration |
| M3 - WebTorrent in the browser | 2.1–2.5 | Browser client, magnet/.torrent input, metadata, swarm states, peer discovery |
| M4 - Playback | 3.1–3.5 | Picking the media file, sequential download, streaming into a `<video>`, buffer health |
| M5 - Codecs & storage hardening | 4.1–4.5 | Codec audit, unsupported-format errors, browser storage limits, optional FFmpeg.wasm and Playwright e2e |

The Dashboard shows live progress for each milestone.

## Working on a step

1. Check the step shows `Ready` in the Tracker, and read its row in
   Risks & Decisions if it has one. For example, the chunk store has to be
   chosen before step 2.1.
2. Set its Status to `In Progress` and fill in Actual Start.
3. Branch off the latest `main`.
4. Prefix commit messages with the step ID, e.g. `2.1: Instantiate WebTorrent client`.
   Commits that don't belong to a step (docs, tooling) have no prefix.
5. Before opening a pull request, make sure these pass:
   ```sh
   npm run typecheck
   npm test
   npm run build
   ```
   Add or update tests as described in [TESTING.md](TESTING.md). There is no CI
   yet, so these local runs are the only check.
6. Open a pull request against `main`, with the step ID and name in the title.
   PRs are merged with a merge commit.
7. Once it's merged, set the step to `Done` and fill in its Completed Date.
   That unblocks dependent steps and updates their planned dates.

If a step can't continue, set its Status to `Blocked` and note why in
Technical Notes / Risks. If the reason is a decision, add it to Risks & Decisions.

## Changing the plan

### Adding a step

1. Insert a row **inside** the existing step rows, not below the last one,
   preferably right after the step it depends on. The Dashboard ranges and
   colour rules then grow to include it automatically.
2. Fill in the input columns. Enter the Step ID as text so `1.10` doesn't
   become `1.1`.
3. Copy the formulas for Ready?, Planned Start, Planned End and Schedule from
   the row above, then check two things:
   - Planned Start's lookup ranges (`$A$4:A…`, `$J$4:J…` and so on) end at the
     row directly above.
   - The row directly below still includes the new row in its own ranges.
     Inserting a row can leave the next row's ranges one short, and that shows
     up as `#N/A` dates.
4. A step can only depend on a step in a row **above** it, because the lookup
   only searches upwards.
5. Insert the same row on the Timeline tab, with `=Tracker!A<n>`, `C<n>`,
   `D<n>`, `I<n>` and `J<n>` pointing at the new Tracker row.

### Adding a milestone

Add a row on the Dashboard by copying an existing milestone row, and make sure
the Total row's `SUM` ranges include it. The milestone name must exactly match
the text used in the Tracker's Milestone column.

### Re-estimating

Change Est. Days and the dates recalculate. If the whole plan needs to shift,
change the project start date in `D3`.
