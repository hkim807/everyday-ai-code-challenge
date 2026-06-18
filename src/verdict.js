// The verdict engine - deterministic, no LLM. Produces exactly one of the four
// action-tied categories Sam's team works in:
//   - Flagged (needs review)   : postponed/cancelled hard stop, or a credible
//                                Tier 1 clash (never auto-resolved)
//   - Change recommended       : a single fresh Tier 1 time that differs from feed
//   - Confirmed (no change)    : a single fresh Tier 1 time that matches feed
//   - Insufficient evidence    : nothing fresh + Tier 1 to act on (feed time stays)
// Governing bias: a wrong time is far worse than a missed one, so when in doubt
// we flag or fall back to "Insufficient", never guess.

import { sameUtcInstant, utcMillis } from "./normalize.js";

function receiptForRow(row) {
  return {
    source_id: row.source_id,
    source_type: row.source_type,
    source_handle: row.account?.handle ?? row.provider ?? row.url ?? null,
    evidence_timestamp: row.evidence_timestamp,
    candidate_kickoff_utc: row.candidate_kickoff_utc,
    candidate_kickoff_time_local: row.candidate_kickoff_time_local ?? null,
    resolved_timezone: row.resolved_timezone ?? null,
    trust_tier: row.trust_tier,
    freshness: row.freshness,
  };
}

function uniqueUtcTimes(rows) {
  const times = [];

  for (const row of rows) {
    if (
      row.candidate_kickoff_utc &&
      !times.some((time) => sameUtcInstant(time, row.candidate_kickoff_utc))
    ) {
      times.push(row.candidate_kickoff_utc);
    }
  }

  return times;
}

function rowsForUtc(rows, utc) {
  return rows.filter((row) => sameUtcInstant(row.candidate_kickoff_utc, utc));
}

function accountKey(row) {
  const handle = row.account?.handle?.toLowerCase().trim();
  return handle || null;
}

// Two posts from the SAME verified account are not a genuine clash - the club
// updating its own channel means the latest post supersedes the earlier one.
// Collapse each account to its newest candidate-bearing row before we look for
// disagreement, so a self-update (e.g. "now kicks off at 7:30") is treated as a
// change, not a Tier 1 conflict. Rows without an account handle pass through.
function collapseSameAccountToNewest(rows) {
  const newestByAccount = new Map();
  const passthrough = [];

  for (const row of rows) {
    const key = accountKey(row);
    if (!key) {
      passthrough.push(row);
      continue;
    }

    const existing = newestByAccount.get(key);
    const rowMillis = utcMillis(row.evidence_timestamp) ?? Number.NEGATIVE_INFINITY;
    const existingMillis =
      existing && (utcMillis(existing.evidence_timestamp) ?? Number.NEGATIVE_INFINITY);

    if (!existing || rowMillis > existingMillis) {
      newestByAccount.set(key, row);
    }
  }

  return [...passthrough, ...newestByAccount.values()];
}

export function classifyVerdict(fixture, rows, evidenceUnavailable = false) {
  // Postponed/cancelled is a hard stop and must fire even when the evidence
  // gateway failed - fixture.status comes from the fixtures endpoint, which is
  // independent of the flaky evidence endpoint. Checking this BEFORE the
  // evidence-unavailable branch stops a known-postponed match from silently
  // degrading to "Insufficient evidence" during a 503.
  const postponedRows = rows.filter((row) => row.is_postponed_or_cancelled);
  const statusHardStop =
    fixture.status === "postponed" || fixture.status === "cancelled";

  if (statusHardStop || postponedRows.length > 0) {
    const why =
      statusHardStop && postponedRows.length === 0
        ? `Feed already marks this fixture '${fixture.status}'; hard stop, do not propose a new kickoff time (reschedules return via league resequencing).`
        : "Postponed/cancelled signal present; hard stop, do not propose a new kickoff time (reschedules return via league resequencing).";
    return {
      fixture_id: fixture.id,
      verdict: "Flagged (needs review)",
      recommended_kickoff_utc: null,
      why,
      receipts: postponedRows.map(receiptForRow),
    };
  }

  if (evidenceUnavailable) {
    return {
      fixture_id: fixture.id,
      verdict: "Insufficient evidence",
      recommended_kickoff_utc: null,
      why: "Evidence unavailable for this fixture (gateway error after retries); current feed time is not verified.",
      receipts: [],
    };
  }

  const freshTier1Rows = collapseSameAccountToNewest(
    rows.filter(
      (row) =>
        row.trust_tier === 1 && row.freshness === "fresh" && row.candidate_kickoff_utc,
    ),
  );
  const tier1Times = uniqueUtcTimes(freshTier1Rows);

  if (tier1Times.length > 1) {
    return {
      fixture_id: fixture.id,
      verdict: "Flagged (needs review)",
      recommended_kickoff_utc: null,
      candidate_kickoff_utc_values: tier1Times,
      why: "Credible Tier 1 sources disagree on kickoff time (club vs league or two official channels); not auto-resolved - both candidate times shown below.",
      receipts: freshTier1Rows.map(receiptForRow),
    };
  }

  if (tier1Times.length === 1 && !sameUtcInstant(tier1Times[0], fixture.kickoff_utc)) {
    const recommended = tier1Times[0];
    return {
      fixture_id: fixture.id,
      verdict: "Change recommended",
      recommended_kickoff_utc: recommended,
      why: "Fresh Tier 1 source supports a new kickoff time with no Tier 1 clash.",
      receipts: rowsForUtc(freshTier1Rows, recommended).map(receiptForRow),
    };
  }

  if (tier1Times.length === 1 && sameUtcInstant(tier1Times[0], fixture.kickoff_utc)) {
    return {
      fixture_id: fixture.id,
      verdict: "Confirmed (no change)",
      recommended_kickoff_utc: null,
      why: "Fresh Tier 1 source corroborates the current feed time.",
      receipts: rowsForUtc(freshTier1Rows, fixture.kickoff_utc).map(receiptForRow),
    };
  }

  return {
    fixture_id: fixture.id,
    verdict: "Insufficient evidence",
    recommended_kickoff_utc: null,
    why: "No fresh Tier 1 kickoff candidate; ScoreFeed/web/stale-only evidence cannot trigger a verdict.",
    receipts: rows.map(receiptForRow),
  };
}
