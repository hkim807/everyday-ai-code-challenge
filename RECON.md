# Step 1 Data Recon

Ran `npm start` against the read-only challenge API and inspected the fixtures
list plus evidence for `fx-2201`, `fx-2202`, and `fx-2203`.

## Fixture Fields Observed

- `id`
- `competition`
- `home`
- `away`
- `status`
- `kickoff_utc`
- `venue.name`
- `venue.city`
- `venue.timezone`
- `last_verified_at`

## Evidence Envelope Fields Observed

- `fixture_id`
- `evidence`

## `social_post` Fields Observed

- `id`
- `type`
- `platform`
- `account.handle`
- `account.display_name`
- `account.verified`
- `posted_at`
- `text`
- `likes`

## `feed_listing` Fields Observed

- `id`
- `type`
- `provider`
- `retrieved_at`
- `fixture_name`
- `listed_kickoff_utc`

## `web_page` Fields Observed

- `id`
- `type`
- `url`
- `title`
- `snippet`
- `fetched_at`

## Notes

- The fixtures endpoint returns an object with a `fixtures` array.
- The evidence endpoint returns an object with `fixture_id` and an `evidence`
  array.
- `fx-2201` included `social_post` and `web_page` evidence.
- `fx-2202` included all three observed evidence types:
  `social_post`, `feed_listing`, and `web_page`.
- `fx-2203` included `social_post` and `feed_listing`, including postponed
  language in official-looking posts.
- During recon, the evidence endpoint returned one intermittent `503` for
  `fx-2202`, then succeeded on rerun. Step 2 should handle that properly with
  timeout, retry, backoff, and graceful per-fixture failure.
