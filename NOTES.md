# Pitchside Kickoff Verification Notes

## Governing Principles (from the Sam call)

Every design choice below traces back to something Sam Kowalski (Head of Ops)
said on the discovery call. The throughline is: **a wrong time is far worse than
a missed one, so when in doubt, don't decide.**

- **A wrong kickoff to broadcasters is ~10x worse than a missed update.**
  → The tool *recommends, never writes*; it stays conservative and flags rather
  than guesses when evidence is thin or contradictory. This is the principle
  that governs everything else.
- **"Five good flags a day, two analysts, ~30 minutes" - five is the ceiling,
  not forty.** → Output is skimmable and ranked (action-needed first, by
  kickoff), and we never escalate on "stale silence" alone, so the queue stays
  small enough to actually clear.
- **Trust order: fresh official comms first (league + verified club), ScoreFeed
  as supporting context only, random web listings dead last.** → This is the
  Tier 1 / Tier 2 / Tier 3 system. Only a fresh Tier 1 source can move or
  confirm a time.
- **"ScoreFeed is the trap - clean and structured but it echoes the old kickoff
  for days. Never act on ScoreFeed alone."** → ScoreFeed (Tier 2) never triggers
  a change or a flag by itself; a fresh verified club post beats it.
- **"Club vs league, or two official-looking times = automatic flag with both
  candidate times and receipts. Don't pick a winner."** → Credible Tier 1
  disagreement is never auto-resolved; it renders as a flag showing both times
  and the receipts behind each.
- **"Anything that smells like postponed/cancelled is an automatic human stop -
  and the tool must not recommend a new time at all."** → Postponed/cancelled is
  a hard stop that flags with no recommended time, even when the posts look
  official (reschedules return via the league's resequencing process).
- **"Stale silence must never be a positive signal. Confirmed is reserved for
  fresh official comms corroborating the current time."** → Thin/old evidence is
  labelled *Insufficient evidence* (current time stays in feed, unverified), not
  *Confirmed*. Confirmed requires a fresh Tier 1 corroboration.
- **Output taxonomy was co-designed on the call.** Sam rejected a muddled
  "Confirmed (change has occurred)" and split it into four action-tied
  categories the analysts actually work in: **Confirmed (no change)**,
  **Change recommended**, **Flagged (needs review)**, and
  **Insufficient evidence**.

## Requirements Gathered

- The tool is read-only: it never writes to the feed and never acts
  autonomously.
- Every monitored fixture receives exactly one verdict.
- LLM usage is limited to extracting structured facts from messy social/web
  evidence.
- Final verdict logic is deterministic code.
- ScoreFeed is supporting context only and never triggers a change or flag by
  itself.
- Postponed/cancelled evidence is a hard stop: flag for review and do not
  recommend a new kickoff time.
- One bad evidence fetch must not stop the run.

## Assumptions

- `FRESHNESS_WINDOW_DAYS = 14`.
- Fresh evidence must be newer than `last_verified_at` and no older than the
  freshness window relative to the run date.
- Verified social accounts matching the home club, away club, or competition
  are treated as official Tier 1 sources.
- ScoreFeed listings are Tier 2.
- Web snippets and unverified social posts are Tier 3.
- If extracted text has no stated timezone, the venue timezone is used.
- Weekday/date references are resolved against the fixture date.
- The report includes all fixtures, but ranks only action-needed items at the
  top.

## Design Decisions

- Kept the API client resilient with timeout, retry, backoff, and per-fixture
  `evidence_unavailable` handling.
- Kept LLM extraction narrow and structured; it returns candidate facts, not
  trust or verdict decisions.
- Parsed ScoreFeed directly from `listed_kickoff_utc`.
- Preserved source metadata from raw evidence so source tiering can be decided
  deterministically.
- Compared kickoff times as UTC instants, not strings, to avoid false
  differences like `Z` versus `.000Z`.
- Chose authority and recency over mention count; no frequency counting is used.
- **Same account, newest wins.** Two posts from the *same* verified team
  account are not a genuine clash - the club updating its own channel means the
  latest post supersedes the earlier one. Before testing for Tier 1
  disagreement we collapse each account to its newest candidate-bearing post
  (`collapseSameAccountToNewest`). A self-update such as Prairie Union's
  "SCHEDULE UPDATE ... will now kick off at 7:30 PM" (fx-2204) is therefore
  treated as a clean **Change recommended**, not a flag, and does not spend one
  of the day's ~5 flags. A real clash (e.g. club vs league, fx-2205) stays a
  flag because the times come from *different* accounts.
- **Postponed is a hard stop even when the evidence gateway fails.**
  `fixture.status` comes from the fixtures endpoint, which is independent of the
  flaky evidence endpoint, so the postponed/cancelled check runs *before* the
  evidence-unavailable branch. A known-postponed match never silently degrades
  to "Insufficient evidence" during a 503.
- **Flags carry their receipts.** Clash flags render both candidate times
  (e.g. `01:00Z vs 01:30Z`) plus per-source receipts showing the UTC time, the
  local clock wording, the account/handle, post timestamp, tier and freshness -
  so an analyst can action a flag without opening the raw evidence.
- **`npm start` produces the operations report** (same as `npm run report`).
  The recon dump and staged-pipeline debugging now live behind
  `RUN_RECON=1` (`npm run recon`, `npm run extract`, etc.).

## Code Structure

- **The pipeline is split into single-responsibility modules** under `src/`,
  with `index.js` as a thin orchestrator. Each stage owns one concern:
  - `config.js` - constants, timezone aliases, locale tables, LLM schema
  - `api.js` - resilient fetch (timeout, retry, backoff) + evidence fetching
  - `extraction.js` - the *only* module that talks to the LLM
  - `normalize.js` - local time -> UTC, plus shared instant helpers
  - `classify.js` - trust tier + freshness
  - `verdict.js` - the deterministic verdict engine
  - `report.js` - ranking + console/markdown/JSON output
- **Why:** the logic Pitchside will most want to tune lives in narrow,
  swappable places. Re-tiering a source, changing the freshness window, adding a
  conflict rule, or reformatting the report each touches one module, so a change
  to *judgment* cannot accidentally break *fetching* or *rendering*. The stages
  connect through plain data (extraction rows -> normalized rows -> classified
  rows -> verdict), so each can be reasoned about and later unit-tested in
  isolation without the live API or OpenAI.
- **The end-to-end flow is the contract.** `index.js` wires the stages in a
  fixed order; altering one stage's internals leaves that wiring untouched. This
  was validated during the single-file -> modules refactor: the report output
  was byte-identical before and after, proving the seams carry the same data.
- **The LLM boundary is deliberately visible.** `extraction.js` is the sole
  importer of `openai`; everything downstream is deterministic code. Keeping
  that in its own file makes the "LLM extracts facts, code makes decisions"
  guarantee obvious and easy to audit.

## Surprises In The Data

- The evidence endpoint really does return intermittent `503`s, sometimes even
  after retries.
- Some evidence has useful non-English timezone wording, such as
  `hora de Denver`.
- Some verified official posts mention different fixtures, so extraction must
  reject off-fixture evidence before verdict logic sees it as actionable.
- Some official postponed notices include replay times, but the guardrail still
  requires a flag with no recommended time.

## Pushback / Risks

- The current Tier 1 official-account matching is heuristic. In production I
  would want a maintained allowlist of official league and club handles.
- Web pages are all Tier 3 right now, even a league website snippet. If the API
  later provides structured publisher/official metadata, that should be used.
- Freshness policy is configurable as a constant, but analysts should validate
  whether 14 days is operationally right.
- The report can produce more than five action-needed items; the brief says
  roughly five is the realistic analyst ceiling, but the deterministic rules
  should not hide real Tier 1 changes or hard-stop flags. The current slate
  yields six action items, but they span different match-days (20 Jun - 1 Jul),
  so the per-day load is within budget. The report does not yet bucket by day;
  if a single day ever exceeded five, an analyst would have to eyeball it.
- **Confidence within a verdict is not graded.** A change backed by two clubs
  plus a league page (fx-2201) renders identically to one backed by a single
  club post (fx-2209). Both are valid recommendations a human applies, but
  surfacing corroboration strength would help triage. Left out deliberately to
  keep the taxonomy small.
- **A single fresh Tier 1 post is enough to recommend a change.** This matches
  Sam's "a verified club post can be strong evidence for a recommendation," and
  the human still applies it. We do not require a second corroborating source,
  trading a little caution for not missing real moves - acceptable only because
  the tool never writes.
- **The official league website is capped at Tier 3.** Every `web_page` is
  Tier 3, so `cslsoccer.com` is treated like a blog. It did not bite on this
  slate (clubs agreed), but a fixture whose only confirmation was the official
  league site would wrongly land "Insufficient evidence." See the web-page note
  above; needs structured publisher metadata to fix properly.

## Setting Aside / Out Of Scope

- No per-day flag bucketing or a 5-flag budget guard in the report.
- No confidence/corroboration grading inside a verdict category.
- No distinction in the output between "gateway failed, could not check" and
  "checked, evidence too weak" - both read as "Insufficient evidence" (the
  `why` text differs, but the status is shared).
- No `fixture_name` cross-check on ScoreFeed listings against home/away; the
  collector's attribution is trusted.
- Postponed/cancelled flags fire on any source tier, so an unverified Tier 3
  "postponed" claim still forces a flag. Chosen as safe-but-noisy because a
  missed postponement is the worst outcome; could be tightened to credible
  sources later.

## With More Time

- Add fixture/source fixtures as local test data so verdicts can be regression
  tested without live API or OpenAI calls.
- Add an official-source allowlist and source taxonomy config.
- Split the single-file script into modules once behavior stabilizes.
- Cache extraction results per evidence id to reduce repeated OpenAI calls.
- Add a compact report mode that suppresses intermediate receipts unless the
  analyst expands a fixture.
