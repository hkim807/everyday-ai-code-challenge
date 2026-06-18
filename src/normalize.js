// Normalizes an extracted local kickoff ("6:00 PM ET", "Saturday") into a UTC
// instant so candidates can be compared. Uses IANA zones via Luxon so DST is
// applied for the actual match date. Also exports the small UTC-instant helpers
// shared by the verdict and report layers.

import { DateTime } from "luxon";

import { MONTH_NUMBERS, WEEKDAY_NUMBERS, ZONE_ALIASES } from "./config.js";

// Compare kickoff times as UTC instants, not strings, so `Z` vs `.000Z` and
// equivalent offsets never read as a false difference.
export function utcMillis(value) {
  const parsed = DateTime.fromISO(value ?? "", { zone: "utc" });
  return parsed.isValid ? parsed.toMillis() : null;
}

export function sameUtcInstant(left, right) {
  const leftMillis = utcMillis(left);
  const rightMillis = utcMillis(right);
  return leftMillis !== null && rightMillis !== null && leftMillis === rightMillis;
}

function zoneFromStatedTimezone(statedTimezone, venueTimezone) {
  if (!statedTimezone) {
    return venueTimezone;
  }

  const normalized = statedTimezone.trim().toLowerCase();
  const aliasedZone = ZONE_ALIASES.get(normalized) ?? statedTimezone;
  return DateTime.local().setZone(aliasedZone).isValid ? aliasedZone : venueTimezone;
}

function findWeekday(reference) {
  const normalized = reference.toLowerCase();
  for (const [name, weekday] of WEEKDAY_NUMBERS.entries()) {
    if (new RegExp(`\\b${name}\\b`, "i").test(normalized)) {
      return weekday;
    }
  }

  return null;
}

function parseExplicitDate(reference, fixtureDate, zone) {
  const cleaned = reference.replace(/,/g, " ");
  const dayMonthMatch = cleaned.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/i);
  const monthDayMatch = cleaned.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);

  const match = dayMonthMatch
    ? { day: Number(dayMonthMatch[1]), monthText: dayMonthMatch[2] }
    : monthDayMatch
      ? { day: Number(monthDayMatch[2]), monthText: monthDayMatch[1] }
      : null;

  if (!match) {
    return null;
  }

  const month = MONTH_NUMBERS.get(match.monthText.toLowerCase());
  if (!month) {
    return null;
  }

  const date = DateTime.fromObject(
    { year: fixtureDate.year, month, day: match.day },
    { zone },
  );

  return date.isValid ? date : null;
}

// Anchor a weekday/date reference to the fixture's own date - we are verifying
// THIS fixture, so the nearest matching weekday to the scheduled date wins.
function resolveReferenceDate(extraction, fixture, zone) {
  const fixtureDate = DateTime.fromISO(fixture.kickoff_utc, { zone: "utc" }).setZone(
    zone,
  );
  const reference = extraction.referenced_date_or_weekday?.trim();

  if (!reference) {
    return fixtureDate;
  }

  const explicitDate = parseExplicitDate(reference, fixtureDate, zone);
  if (explicitDate) {
    return explicitDate;
  }

  const weekday = findWeekday(reference);
  if (!weekday) {
    return fixtureDate;
  }

  let candidate = fixtureDate;
  for (let offset = -7; offset <= 7; offset += 1) {
    const possible = fixtureDate.plus({ days: offset });
    if (possible.weekday === weekday) {
      if (
        Math.abs(possible.startOf("day").diff(fixtureDate.startOf("day"), "days").days) <
        Math.abs(candidate.startOf("day").diff(fixtureDate.startOf("day"), "days").days)
      ) {
        candidate = possible;
      }
    }
  }

  return candidate;
}

function parseLocalTime(timeText, date, zone) {
  const normalized = timeText.trim().toUpperCase().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);

  if (!match) {
    return { value: null, reason: `Unrecognized time format: ${timeText}` };
  }

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (meridiem === "PM" && hour < 12) {
    hour += 12;
  }

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  const value = DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour, minute },
    { zone },
  );

  return value.isValid
    ? { value, reason: null }
    : { value: null, reason: value.invalidExplanation ?? "Invalid local time" };
}

export function normalizeExtractionToUtc(extraction, fixture) {
  if (extraction.source_type === "feed_listing") {
    const value = DateTime.fromISO(extraction.referenced_date_or_weekday, {
      zone: "utc",
    });

    return {
      source_id: extraction.source_id,
      source_type: extraction.source_type,
      provider: extraction.provider,
      account: extraction.account,
      url: extraction.url,
      evidence_timestamp: extraction.evidence_timestamp,
      is_postponed_or_cancelled: extraction.is_postponed_or_cancelled,
      is_this_about_this_fixture: extraction.is_this_about_this_fixture,
      is_this_actually_kickoff: extraction.is_this_actually_kickoff,
      candidate_kickoff_time_local: extraction.candidate_kickoff_time_local,
      stated_timezone: extraction.stated_timezone,
      referenced_date_or_weekday: extraction.referenced_date_or_weekday,
      resolved_timezone: "UTC",
      candidate_kickoff_utc: value.isValid ? value.toUTC().toISO() : null,
      normalization_note: value.isValid
        ? "ScoreFeed listed_kickoff_utc parsed directly."
        : "ScoreFeed listed_kickoff_utc was not a valid ISO datetime.",
    };
  }

  if (
    !extraction.candidate_kickoff_time_local ||
    !extraction.is_this_about_this_fixture ||
    !extraction.is_this_actually_kickoff
  ) {
    return {
      source_id: extraction.source_id,
      source_type: extraction.source_type,
      provider: extraction.provider,
      account: extraction.account,
      url: extraction.url,
      evidence_timestamp: extraction.evidence_timestamp,
      is_postponed_or_cancelled: extraction.is_postponed_or_cancelled,
      is_this_about_this_fixture: extraction.is_this_about_this_fixture,
      is_this_actually_kickoff: extraction.is_this_actually_kickoff,
      candidate_kickoff_time_local: extraction.candidate_kickoff_time_local,
      stated_timezone: extraction.stated_timezone,
      referenced_date_or_weekday: extraction.referenced_date_or_weekday,
      resolved_timezone: null,
      candidate_kickoff_utc: null,
      normalization_note: "No valid kickoff candidate to normalize.",
    };
  }

  const zone = zoneFromStatedTimezone(
    extraction.stated_timezone,
    fixture.venue?.timezone,
  );
  const date = resolveReferenceDate(extraction, fixture, zone);
  const parsedTime = parseLocalTime(extraction.candidate_kickoff_time_local, date, zone);

  return {
    source_id: extraction.source_id,
    source_type: extraction.source_type,
    provider: extraction.provider,
    account: extraction.account,
    url: extraction.url,
    evidence_timestamp: extraction.evidence_timestamp,
    is_postponed_or_cancelled: extraction.is_postponed_or_cancelled,
    is_this_about_this_fixture: extraction.is_this_about_this_fixture,
    is_this_actually_kickoff: extraction.is_this_actually_kickoff,
    candidate_kickoff_time_local: extraction.candidate_kickoff_time_local,
    stated_timezone: extraction.stated_timezone,
    referenced_date_or_weekday: extraction.referenced_date_or_weekday,
    resolved_timezone: zone,
    resolved_local_datetime: parsedTime.value?.toISO() ?? null,
    candidate_kickoff_utc: parsedTime.value?.toUTC().toISO() ?? null,
    normalization_note:
      parsedTime.reason ??
      `Resolved against fixture date using ${extraction.stated_timezone ? "stated timezone" : "venue timezone"}.`,
  };
}
