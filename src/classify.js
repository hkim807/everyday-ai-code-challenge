// Assigns each normalized candidate a trust tier and a freshness label - the two
// axes the verdict engine reasons over. Trust order is Sam's stated hierarchy:
// fresh official comms (Tier 1) > ScoreFeed supporting context (Tier 2) >
// web/unverified (Tier 3). Freshness gates whether a source is recent enough to
// be allowed to confirm or move a time at all.

import { DateTime } from "luxon";

import { FRESHNESS_WINDOW_DAYS } from "./config.js";

// Tier 1 requires a verified account whose name/handle matches the home club,
// away club, or competition. Heuristic for the prototype; production would use a
// maintained allowlist of official handles (see NOTES.md).
function isOfficialSocialAccount(account, fixture) {
  if (!account?.verified) {
    return false;
  }

  const displayName = account.display_name?.toLowerCase() ?? "";
  const handle = account.handle?.toLowerCase() ?? "";
  const officialNames = [
    fixture.home,
    fixture.away,
    fixture.competition,
    "Continental Soccer League",
    "CSLeague",
  ].map((value) => value.toLowerCase());

  return officialNames.some((name) => {
    const compactName = name.replace(/[^a-z0-9]/g, "");
    return (
      displayName === name ||
      displayName.includes(name) ||
      handle.replace(/[^a-z0-9]/g, "").includes(compactName)
    );
  });
}

function classifyTrustTier(row, fixture) {
  if (row.source_type === "feed_listing") {
    return {
      trust_tier: 2,
      trust_label: "Tier 2 - ScoreFeed supporting context",
    };
  }

  if (row.source_type === "social_post" && isOfficialSocialAccount(row.account, fixture)) {
    return {
      trust_tier: 1,
      trust_label: "Tier 1 - verified official club/competition channel",
    };
  }

  if (row.source_type === "web_page") {
    return {
      trust_tier: 3,
      trust_label: "Tier 3 - web listing/snippet",
    };
  }

  return {
    trust_tier: 3,
    trust_label: "Tier 3 - unverified or unsupported source",
  };
}

// Fresh = posted at/after the last manual verification AND within the freshness
// window relative to now. "Stale silence" can therefore never be treated as
// confirmation - it simply drops out of the Tier 1 set.
function classifyFreshness(row, fixture) {
  const evidenceTime = DateTime.fromISO(row.evidence_timestamp ?? "", { zone: "utc" });
  const lastVerifiedAt = DateTime.fromISO(fixture.last_verified_at, { zone: "utc" });
  const now = DateTime.utc();

  if (!evidenceTime.isValid) {
    return {
      freshness: "unknown",
      freshness_age_days: null,
      freshness_note: "No valid evidence timestamp.",
    };
  }

  if (!lastVerifiedAt.isValid) {
    return {
      freshness: "unknown",
      freshness_age_days: null,
      freshness_note: "No valid fixture last_verified_at timestamp.",
    };
  }

  const daysAfterLastVerified = evidenceTime.diff(lastVerifiedAt, "days").days;
  const ageDays = Math.max(0, now.diff(evidenceTime, "days").days);
  const freshness =
    daysAfterLastVerified >= 0 && ageDays <= FRESHNESS_WINDOW_DAYS ? "fresh" : "stale";

  return {
    freshness,
    freshness_age_days: Number(ageDays.toFixed(2)),
    freshness_days_after_last_verified: Number(daysAfterLastVerified.toFixed(2)),
    freshness_note: `${freshness}: evidence is ${Number(ageDays.toFixed(2))} days old and ${Number(daysAfterLastVerified.toFixed(2))} days after last_verified_at using ${FRESHNESS_WINDOW_DAYS}-day window.`,
  };
}

export function classifyNormalizedCandidates(fixture, normalizedRows) {
  return normalizedRows.map((row) => ({
    ...row,
    ...classifyTrustTier(row, fixture),
    ...classifyFreshness(row, fixture),
  }));
}
