# Pitchside Kickoff Verification

A small Node.js tool that checks the kickoff time of every monitored fixture
against the evidence Pitchside's collectors have gathered (club/league social
posts, ScoreFeed listings, web snippets), then produces a ranked, skimmable
report telling the operations team what to do about each one.

It **recommends, it never writes** to the feed. An LLM is used only to extract
structured facts from messy social/web text; every trust, freshness, and verdict
decision is made by deterministic code.

See [`NOTES.md`](./NOTES.md) for the requirements, design decisions, and
trade-offs.

## Prerequisites

- **Node.js 18+** (uses the built-in `fetch`)
- An **OpenAI API key** (used for the extraction step)

## Setup

```bash
npm install
```

Create a `.env` file in the project root with your OpenAI key:

```
OPENAI_API_KEY="sk-..."
```

`.env` is gitignored, so the key is never committed.

## Run

```bash
npm start
```

(`npm run report` does the same thing.)

This fetches every fixture, gathers and weighs the evidence, prints the report to
the console, and writes two files:

- **`report.md`** — human-readable report for the ops team
- **`report.json`** — the same results, machine-readable

## What the report says

Each fixture lands in one of four action-tied categories:

| Verdict | Meaning |
|---|---|
| **Confirmed (no change)** | Fresh official source corroborates the current feed time |
| **Change recommended** | Fresh official source supports a new time (with old → new + receipts) |
| **Flagged (needs review)** | Postponed/cancelled, or credible sources disagree — needs a human |
| **Insufficient evidence** | Nothing fresh and trusted to act on; current time stays in the feed |

Action-needed items (changes + flags) are ranked to the top by soonest kickoff.

## Notes on the API

The evidence endpoint sits behind an older gateway that returns intermittent
`503`s and can be slow. Each request has a timeout plus bounded retries with
backoff; a fixture whose evidence can't be fetched is reported as *Insufficient
evidence* rather than crashing the run.

To exercise that path deterministically:

```bash
FORCE_EVIDENCE_FAILURE_ID=fx-2203 node index.js
```

## Project layout

```
index.js          # entry point: orchestrates the per-fixture pipeline
src/config.js     # constants, timezone aliases, locale tables, LLM schema
src/api.js        # resilient fetch + evidence fetching
src/extraction.js # the only module that calls the LLM
src/normalize.js  # local time -> UTC + shared instant helpers
src/classify.js   # trust tier + freshness
src/verdict.js    # deterministic verdict engine
src/report.js     # ranking + console/markdown/JSON output
```
