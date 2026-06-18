import OpenAI from "openai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DateTime } from "luxon";

const API_BASE_URL =
  "https://everyday-sim-463015353641.us-east1.run.app/api/challenge";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const FORCED_FAILURE_FIXTURE_ID = process.env.FORCE_EVIDENCE_FAILURE_ID;
const RUN_EXTRACTION = process.env.RUN_EXTRACTION === "1";
const RUN_NORMALIZATION = process.env.RUN_NORMALIZATION === "1";
const RUN_CLASSIFICATION = process.env.RUN_CLASSIFICATION === "1";
const RUN_VERDICTS = process.env.RUN_VERDICTS === "1";
const RUN_REPORT = process.env.RUN_REPORT === "1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const FRESHNESS_WINDOW_DAYS = 14;

const WEEKDAY_NUMBERS = new Map([
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tue", 2],
  ["tues", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6],
  ["domingo", 7],
  ["sunday", 7],
  ["sun", 7],
  ["lunes", 1],
  ["martes", 2],
  ["miercoles", 3],
  ["miércoles", 3],
  ["jueves", 4],
  ["viernes", 5],
  ["sabado", 6],
  ["sábado", 6],
]);

const MONTH_NUMBERS = new Map([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["sept", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

const extractionResponseFormat = {
  type: "json_schema",
  name: "kickoff_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidate_kickoff_time_local: {
        type: ["string", "null"],
        description:
          "The stated local kickoff clock time only, such as '6:00 PM' or '19:00'. Null if absent or if the time is not actually kickoff.",
      },
      stated_timezone: {
        type: ["string", "null"],
        description:
          "The timezone stated in the evidence, preserving wording such as ET, Eastern, MT, or America/New_York. Null if no timezone is stated.",
      },
      referenced_date_or_weekday: {
        type: ["string", "null"],
        description:
          "The referenced match date or weekday exactly as stated, such as 'Saturday', 'Mon 22 Jun', or 'Wednesday 8 July'. Null if absent.",
      },
      is_this_about_this_fixture: {
        type: "boolean",
        description:
          "True only when the evidence is about the supplied home/away fixture, not another match.",
      },
      is_postponed_or_cancelled: {
        type: "boolean",
        description:
          "True if the evidence says this fixture is postponed, cancelled, abandoned, or off.",
      },
      is_this_actually_kickoff: {
        type: "boolean",
        description:
          "True only if candidate_kickoff_time_local is a kickoff/start time, not gates, tickets, parking, broadcast show, or rumor timing.",
      },
      extraction_confidence_note: {
        type: "string",
        description:
          "One concise sentence explaining why the extraction was accepted or rejected.",
      },
    },
    required: [
      "candidate_kickoff_time_local",
      "stated_timezone",
      "referenced_date_or_weekday",
      "is_this_about_this_fixture",
      "is_postponed_or_cancelled",
      "is_this_actually_kickoff",
      "extraction_confidence_note",
    ],
  },
};

let openaiClient;

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for extraction. Set it in the environment and rerun `npm run extract`.",
    );
  }

  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error) {
  return error.name === "AbortError" || error.status === 503;
}

async function fetchJson(url, options = {}) {
  const {
    attempts = MAX_ATTEMPTS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retryBackoffMs = RETRY_BACKOFF_MS,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        const error = new Error(
          `GET ${url} failed: ${response.status} ${response.statusText}`,
        );
        error.status = response.status;
        throw error;
      }

      return response.json();
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !isRetriableError(error)) {
        break;
      }

      const delay = retryBackoffMs * 2 ** (attempt - 1);
      console.warn(
        `GET ${url} failed on attempt ${attempt}/${attempts}; retrying in ${delay}ms: ${error.message}`,
      );
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function unavailableEvidence(fixtureId, error) {
  return {
    fixture_id: fixtureId,
    evidence_unavailable: true,
    evidence: [],
    error: {
      message: error.message,
      status: error.status ?? null,
      retriable: isRetriableError(error),
    },
  };
}

async function fetchEvidenceForFixture(fixtureId) {
  try {
    if (fixtureId === FORCED_FAILURE_FIXTURE_ID) {
      const error = new Error(`Forced evidence failure for ${fixtureId}`);
      error.status = "forced";
      throw error;
    }

    return await fetchJson(`${API_BASE_URL}/fixtures/${fixtureId}/evidence`);
  } catch (error) {
    console.warn(
      `Evidence unavailable for fixture ${fixtureId}; continuing run: ${error.message}`,
    );
    return unavailableEvidence(fixtureId, error);
  }
}

function summarizeFieldNames(value, prefix = "") {
  if (Array.isArray(value)) {
    const fields = new Set();
    for (const item of value) {
      for (const field of summarizeFieldNames(item, prefix)) {
        fields.add(field);
      }
    }
    return [...fields].sort();
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const fields = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const fieldName = prefix ? `${prefix}.${key}` : key;
    fields.push(fieldName);

    if (nestedValue && typeof nestedValue === "object") {
      fields.push(...summarizeFieldNames(nestedValue, fieldName));
    }
  }

  return [...new Set(fields)].sort();
}

function groupEvidenceItems(evidencePayload) {
  const items = Array.isArray(evidencePayload)
    ? evidencePayload
    : Array.isArray(evidencePayload?.evidence)
      ? evidencePayload.evidence
      : Array.isArray(evidencePayload?.items)
        ? evidencePayload.items
        : [];

  return items.reduce((groups, item) => {
    const type = item?.type ?? item?.evidence_type ?? "unknown";
    groups[type] ??= [];
    groups[type].push(item);
    return groups;
  }, {});
}

function evidenceItems(evidencePayload) {
  if (Array.isArray(evidencePayload)) {
    return evidencePayload;
  }

  if (Array.isArray(evidencePayload?.evidence)) {
    return evidencePayload.evidence;
  }

  if (Array.isArray(evidencePayload?.items)) {
    return evidencePayload.items;
  }

  return [];
}

function contentForEvidenceItem(item) {
  if (item.type === "social_post") {
    return {
      kind: "social_post",
      text: item.text,
      posted_at: item.posted_at,
      platform: item.platform,
      account: item.account,
    };
  }

  if (item.type === "web_page") {
    return {
      kind: "web_page",
      title: item.title,
      snippet: item.snippet,
      fetched_at: item.fetched_at,
      url: item.url,
    };
  }

  return item;
}

function parseFeedListing(item) {
  return {
    source_id: item.id,
    source_type: item.type,
    provider: item.provider,
    evidence_timestamp: item.retrieved_at ?? null,
    parsed_directly: true,
    candidate_kickoff_time_local: null,
    stated_timezone: "UTC",
    referenced_date_or_weekday: item.listed_kickoff_utc ?? null,
    is_this_about_this_fixture: true,
    is_postponed_or_cancelled: false,
    is_this_actually_kickoff: Boolean(item.listed_kickoff_utc),
    extraction_confidence_note:
      "ScoreFeed listing is already structured; kept as UTC for later normalization.",
  };
}

function sourceMetadata(item) {
  if (item.type === "social_post") {
    return {
      platform: item.platform,
      account: item.account ?? null,
      evidence_timestamp: item.posted_at ?? null,
    };
  }

  if (item.type === "web_page") {
    return {
      url: item.url,
      title: item.title,
      evidence_timestamp: item.fetched_at ?? null,
    };
  }

  return {
    evidence_timestamp: item.retrieved_at ?? item.fetched_at ?? item.posted_at ?? null,
  };
}

function normalizeNullableString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.trim().toLowerCase() === "null" ? null : value;
}

function sanitizeExtraction(extraction) {
  const sanitized = {
    ...extraction,
    candidate_kickoff_time_local: normalizeNullableString(
      extraction.candidate_kickoff_time_local,
    ),
    stated_timezone: normalizeNullableString(extraction.stated_timezone),
    referenced_date_or_weekday: normalizeNullableString(
      extraction.referenced_date_or_weekday,
    ),
  };

  if (!sanitized.is_this_about_this_fixture || !sanitized.is_this_actually_kickoff) {
    sanitized.candidate_kickoff_time_local = null;
  }

  return sanitized;
}

async function extractKickoffFromEvidence(item, fixture) {
  if (item.type === "feed_listing") {
    return parseFeedListing(item);
  }

  if (item.type !== "social_post" && item.type !== "web_page") {
    return {
      source_id: item.id,
      source_type: item.type ?? "unknown",
      parsed_directly: false,
      candidate_kickoff_time_local: null,
      stated_timezone: null,
      referenced_date_or_weekday: null,
      is_this_about_this_fixture: false,
      is_postponed_or_cancelled: false,
      is_this_actually_kickoff: false,
      extraction_confidence_note: "Unsupported evidence type for Step 3 extraction.",
    };
  }

  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: OPENAI_MODEL,
    temperature: 0,
    instructions: [
      "You extract kickoff-time facts from sports evidence.",
      "Return only the requested JSON structure.",
      "Do not decide a verdict, trust tier, freshness, or whether the feed should change.",
      "If a time is for gates, ticket office, parking, broadcast coverage, or another non-kickoff event, candidate_kickoff_time_local must be null and is_this_actually_kickoff must be false.",
      "If the evidence is about another fixture, candidate_kickoff_time_local must be null and is_this_about_this_fixture must be false.",
      "If the text is a rumor or says no official comment, return null rather than guessing.",
      "If the evidence says postponed or cancelled, set is_postponed_or_cancelled true even if it also mentions a future replay time.",
      "Preserve stated local wording; do not convert to UTC.",
    ].join(" "),
    input: JSON.stringify(
      {
        fixture: {
          id: fixture.id,
          competition: fixture.competition,
          home: fixture.home,
          away: fixture.away,
          kickoff_utc: fixture.kickoff_utc,
          venue_timezone: fixture.venue?.timezone,
        },
        evidence: contentForEvidenceItem(item),
      },
      null,
      2,
    ),
    text: {
      format: extractionResponseFormat,
    },
  });

  return sanitizeExtraction({
    source_id: item.id,
    source_type: item.type,
    ...sourceMetadata(item),
    parsed_directly: false,
    ...JSON.parse(response.output_text),
  });
}

async function printExtractions(fixture, evidence) {
  console.log(`\n=== Extraction results for fixture ${fixture.id} ===`);

  const extractions = await extractEvidenceForFixture(fixture, evidence);
  for (const extraction of extractions) {
    console.dir(extraction, { depth: null });
  }

  return extractions;
}

async function extractEvidenceForFixture(fixture, evidence) {
  const extractions = [];

  for (const item of evidenceItems(evidence)) {
    extractions.push(await extractKickoffFromEvidence(item, fixture));
  }

  return extractions;
}

function zoneFromStatedTimezone(statedTimezone, venueTimezone) {
  if (!statedTimezone) {
    return venueTimezone;
  }

  const normalized = statedTimezone.trim().toLowerCase();
  const zoneAliases = new Map([
    ["et", "America/New_York"],
    ["eastern", "America/New_York"],
    ["eastern time", "America/New_York"],
    ["est", "America/New_York"],
    ["edt", "America/New_York"],
    ["ct", "America/Chicago"],
    ["central", "America/Chicago"],
    ["central time", "America/Chicago"],
    ["cst", "America/Chicago"],
    ["cdt", "America/Chicago"],
    ["mt", "America/Denver"],
    ["mountain", "America/Denver"],
    ["mountain time", "America/Denver"],
    ["mst", "America/Denver"],
    ["mdt", "America/Denver"],
    ["pt", "America/Los_Angeles"],
    ["pacific", "America/Los_Angeles"],
    ["pacific time", "America/Los_Angeles"],
    ["pst", "America/Los_Angeles"],
    ["pdt", "America/Los_Angeles"],
    ["hora de denver", "America/Denver"],
    ["utc", "UTC"],
  ]);

  const aliasedZone = zoneAliases.get(normalized) ?? statedTimezone;
  return DateTime.local().setZone(aliasedZone).isValid ? aliasedZone : venueTimezone;
}

function resolveReferenceDate(extraction, fixture, zone) {
  const fixtureDate = DateTime.fromISO(fixture.kickoff_utc, {
    zone: "utc",
  }).setZone(zone);
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

function parseExplicitDate(reference, fixtureDate, zone) {
  const cleaned = reference.replace(/,/g, " ");
  const dayMonthMatch = cleaned.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\b/i,
  );
  const monthDayMatch = cleaned.match(
    /\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );

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

function findWeekday(reference) {
  const normalized = reference.toLowerCase();
  for (const [name, weekday] of WEEKDAY_NUMBERS.entries()) {
    if (new RegExp(`\\b${name}\\b`, "i").test(normalized)) {
      return weekday;
    }
  }

  return null;
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
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
    },
    { zone },
  );

  return value.isValid
    ? { value, reason: null }
    : { value: null, reason: value.invalidExplanation ?? "Invalid local time" };
}

function normalizeExtractionToUtc(extraction, fixture) {
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
  const parsedTime = parseLocalTime(
    extraction.candidate_kickoff_time_local,
    date,
    zone,
  );

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

function printNormalizedCandidates(fixture, extractions) {
  const rows = extractions.map((extraction) =>
    normalizeExtractionToUtc(extraction, fixture),
  );

  console.log(`\n=== Normalized UTC candidates for fixture ${fixture.id} ===`);
  console.table(
    rows.map((row) => ({
      source_id: row.source_id,
      source_type: row.source_type,
      local_time: row.candidate_kickoff_time_local,
      stated_timezone: row.stated_timezone,
      resolved_timezone: row.resolved_timezone,
      reference: row.referenced_date_or_weekday,
      candidate_kickoff_utc: row.candidate_kickoff_utc,
      note: row.normalization_note,
    })),
  );

  return rows;
}

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
    daysAfterLastVerified >= 0 && ageDays <= FRESHNESS_WINDOW_DAYS
      ? "fresh"
      : "stale";

  return {
    freshness,
    freshness_age_days: Number(ageDays.toFixed(2)),
    freshness_days_after_last_verified: Number(daysAfterLastVerified.toFixed(2)),
    freshness_note: `${freshness}: evidence is ${Number(ageDays.toFixed(2))} days old and ${Number(daysAfterLastVerified.toFixed(2))} days after last_verified_at using ${FRESHNESS_WINDOW_DAYS}-day window.`,
  };
}

function classifyNormalizedCandidates(fixture, normalizedRows) {
  return normalizedRows.map((row) => ({
    ...row,
    ...classifyTrustTier(row, fixture),
    ...classifyFreshness(row, fixture),
  }));
}

function printClassifiedCandidates(fixture, normalizedRows) {
  const rows = classifyNormalizedCandidates(fixture, normalizedRows);

  console.log(`\n=== Classified candidates for fixture ${fixture.id} ===`);
  console.table(
    rows.map((row) => ({
      source_id: row.source_id,
      source_type: row.source_type,
      candidate_kickoff_utc: row.candidate_kickoff_utc,
      trust_tier: row.trust_tier,
      freshness: row.freshness,
      evidence_timestamp: row.evidence_timestamp,
      freshness_age_days: row.freshness_age_days,
      label: row.trust_label,
    })),
  );

  return rows;
}

function receiptForRow(row) {
  return {
    source_id: row.source_id,
    source_type: row.source_type,
    evidence_timestamp: row.evidence_timestamp,
    candidate_kickoff_utc: row.candidate_kickoff_utc,
    trust_tier: row.trust_tier,
    freshness: row.freshness,
  };
}

function utcMillis(value) {
  const parsed = DateTime.fromISO(value ?? "", { zone: "utc" });
  return parsed.isValid ? parsed.toMillis() : null;
}

function sameUtcInstant(left, right) {
  const leftMillis = utcMillis(left);
  const rightMillis = utcMillis(right);
  return leftMillis !== null && rightMillis !== null && leftMillis === rightMillis;
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

function classifyVerdict(fixture, rows, evidenceUnavailable = false) {
  if (evidenceUnavailable) {
    return {
      fixture_id: fixture.id,
      verdict: "Insufficient evidence",
      recommended_kickoff_utc: null,
      why: "Evidence unavailable for this fixture; current feed time is not verified.",
      receipts: [],
    };
  }

  const postponedRows = rows.filter((row) => row.is_postponed_or_cancelled);
  if (postponedRows.length > 0 || fixture.status === "postponed") {
    return {
      fixture_id: fixture.id,
      verdict: "Flagged (needs review)",
      recommended_kickoff_utc: null,
      why: "Postponed/cancelled signal present; do not propose a new kickoff time.",
      receipts: postponedRows.map(receiptForRow),
    };
  }

  const freshTier1Rows = rows.filter(
    (row) => row.trust_tier === 1 && row.freshness === "fresh" && row.candidate_kickoff_utc,
  );
  const tier1Times = uniqueUtcTimes(freshTier1Rows);

  if (tier1Times.length > 1) {
    return {
      fixture_id: fixture.id,
      verdict: "Flagged (needs review)",
      recommended_kickoff_utc: null,
      candidate_kickoff_utc_values: tier1Times,
      why: "Fresh Tier 1 sources disagree on kickoff time.",
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

function printVerdict(fixture, rows, evidenceUnavailable = false) {
  const verdict = classifyVerdict(fixture, rows, evidenceUnavailable);

  console.log(`\n=== Verdict for fixture ${fixture.id} ===`);
  console.dir(verdict, { depth: null });

  return verdict;
}

function actionNeeded(verdict) {
  return (
    verdict.verdict === "Change recommended" ||
    verdict.verdict === "Flagged (needs review)"
  );
}

function kickoffMillis(fixture) {
  return utcMillis(fixture.kickoff_utc) ?? Number.MAX_SAFE_INTEGER;
}

function shiftMagnitudeMs(item) {
  const currentMillis = utcMillis(item.fixture.kickoff_utc);
  if (currentMillis === null) {
    return 0;
  }

  const candidateTimes = [
    item.verdict.recommended_kickoff_utc,
    ...(item.verdict.candidate_kickoff_utc_values ?? []),
    ...item.verdict.receipts.map((receipt) => receipt.candidate_kickoff_utc),
  ].filter(Boolean);

  const shifts = candidateTimes
    .map((time) => utcMillis(time))
    .filter((millis) => millis !== null)
    .map((millis) => Math.abs(millis - currentMillis));

  return shifts.length > 0 ? Math.max(...shifts) : 0;
}

function rankReportItems(items) {
  const actionItems = items
    .filter((item) => actionNeeded(item.verdict))
    .sort((left, right) => {
      const kickoffDiff = kickoffMillis(left.fixture) - kickoffMillis(right.fixture);
      if (kickoffDiff !== 0) {
        return kickoffDiff;
      }

      return shiftMagnitudeMs(right) - shiftMagnitudeMs(left);
    });
  const quietItems = items
    .filter((item) => !actionNeeded(item.verdict))
    .sort((left, right) => kickoffMillis(left.fixture) - kickoffMillis(right.fixture));

  return [...actionItems, ...quietItems];
}

function formatFixtureName(fixture) {
  return `${fixture.home} vs ${fixture.away}`;
}

function recommendedText(verdict) {
  if (verdict.verdict === "Flagged (needs review)") {
    return "none - flag";
  }

  return verdict.recommended_kickoff_utc ?? "none";
}

function receiptText(receipts) {
  if (receipts.length === 0) {
    return "none";
  }

  return receipts
    .map(
      (receipt) =>
        `${receipt.source_id} (${receipt.source_type}, ${receipt.evidence_timestamp ?? "no timestamp"}, tier ${receipt.trust_tier}, ${receipt.freshness})`,
    )
    .join("; ");
}

function renderConsoleReport(items) {
  console.log("\nPitchside Kickoff Verification Report");
  console.log(`Generated: ${DateTime.utc().toISO()}`);
  console.log("\nAction needed");
  const actionItems = items.filter((item) => actionNeeded(item.verdict));
  if (actionItems.length === 0) {
    console.log("  None");
  }
  for (const item of actionItems) {
    console.log(
      `- ${item.fixture.id} ${formatFixtureName(item.fixture)} | ${item.verdict.verdict} | recommended: ${recommendedText(item.verdict)}`,
    );
    console.log(`  Why: ${item.verdict.why}`);
    console.log(`  Receipts: ${receiptText(item.verdict.receipts)}`);
  }

  console.log("\nQuiet roster");
  for (const item of items.filter((entry) => !actionNeeded(entry.verdict))) {
    console.log(
      `- ${item.fixture.id} ${formatFixtureName(item.fixture)} | ${item.verdict.verdict} | recommended: ${recommendedText(item.verdict)}`,
    );
    console.log(`  Why: ${item.verdict.why}`);
    console.log(`  Receipts: ${receiptText(item.verdict.receipts)}`);
  }
}

function renderMarkdownReport(items) {
  const lines = [
    "# Pitchside Kickoff Verification Report",
    "",
    `Generated: ${DateTime.utc().toISO()}`,
    "",
    "## Action Needed",
    "",
  ];

  const actionItems = items.filter((item) => actionNeeded(item.verdict));
  if (actionItems.length === 0) {
    lines.push("None.", "");
  }

  for (const item of actionItems) {
    lines.push(
      `### ${item.fixture.id} - ${formatFixtureName(item.fixture)}`,
      "",
      `- Verdict: ${item.verdict.verdict}`,
      `- Current feed kickoff: ${item.fixture.kickoff_utc}`,
      `- Recommended: ${recommendedText(item.verdict)}`,
      `- Why: ${item.verdict.why}`,
      `- Receipts: ${receiptText(item.verdict.receipts)}`,
      "",
    );
  }

  lines.push("## Quiet Roster", "");
  for (const item of items.filter((entry) => !actionNeeded(entry.verdict))) {
    lines.push(
      `### ${item.fixture.id} - ${formatFixtureName(item.fixture)}`,
      "",
      `- Verdict: ${item.verdict.verdict}`,
      `- Current feed kickoff: ${item.fixture.kickoff_utc}`,
      `- Recommended: ${recommendedText(item.verdict)}`,
      `- Why: ${item.verdict.why}`,
      `- Receipts: ${receiptText(item.verdict.receipts)}`,
      "",
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

async function assessFixture(fixture) {
  const evidence = await fetchEvidenceForFixture(fixture.id);

  if (evidence.evidence_unavailable) {
    return {
      fixture,
      evidence_unavailable: true,
      verdict: classifyVerdict(fixture, [], true),
      candidates: [],
    };
  }

  const extractions = await extractEvidenceForFixture(fixture, evidence);
  const normalizedRows = extractions.map((extraction) =>
    normalizeExtractionToUtc(extraction, fixture),
  );
  const classifiedRows = classifyNormalizedCandidates(fixture, normalizedRows);

  return {
    fixture,
    evidence_unavailable: false,
    verdict: classifyVerdict(fixture, classifiedRows),
    candidates: classifiedRows,
  };
}

async function runReport(fixtureList) {
  const assessedItems = [];

  for (const fixture of fixtureList) {
    assessedItems.push(await assessFixture(fixture));
  }

  const rankedItems = rankReportItems(assessedItems);
  const report = {
    generated_at: DateTime.utc().toISO(),
    freshness_window_days: FRESHNESS_WINDOW_DAYS,
    items: rankedItems,
  };

  renderConsoleReport(rankedItems);
  writeFileSync("report.json", `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync("report.md", renderMarkdownReport(rankedItems));
  console.log("\nWrote report.json and report.md");
}

async function main() {
  loadDotEnv();

  const fixtures = await fetchJson(`${API_BASE_URL}/fixtures`);
  const fixtureList = Array.isArray(fixtures) ? fixtures : fixtures.fixtures ?? [];

  if (RUN_REPORT) {
    await runReport(fixtureList);
    return;
  }

  console.log("=== Fixtures payload ===");
  console.dir(fixtures, { depth: null });
  console.log("\n=== Fixture field names observed ===");
  console.dir(summarizeFieldNames(fixtureList), { depth: null });

  for (const fixture of fixtureList) {
    const fixtureId = fixture.id;
    const evidence = await fetchEvidenceForFixture(fixtureId);
    const groupedEvidence = groupEvidenceItems(evidence);

    console.log(`\n=== Evidence payload for fixture ${fixtureId} ===`);
    console.dir(evidence, { depth: null });

    console.log(`\n=== Evidence field names observed for fixture ${fixtureId} ===`);
    console.dir(summarizeFieldNames(evidence), { depth: null });

    console.log(`\n=== Evidence types observed for fixture ${fixtureId} ===`);
    for (const [type, items] of Object.entries(groupedEvidence)) {
      console.log(`${type}: ${items.length} item(s)`);
      console.dir(summarizeFieldNames(items), { depth: null });
    }

    if (
      (RUN_EXTRACTION || RUN_NORMALIZATION || RUN_CLASSIFICATION || RUN_VERDICTS) &&
      !evidence.evidence_unavailable
    ) {
      const extractions = await printExtractions(fixture, evidence);

      if (RUN_NORMALIZATION || RUN_CLASSIFICATION || RUN_VERDICTS) {
        const normalizedRows = printNormalizedCandidates(fixture, extractions);

        if (RUN_CLASSIFICATION || RUN_VERDICTS) {
          const classifiedRows = printClassifiedCandidates(fixture, normalizedRows);

          if (RUN_VERDICTS) {
            printVerdict(fixture, classifiedRows);
          }
        }
      }
    } else if (RUN_VERDICTS && evidence.evidence_unavailable) {
      printVerdict(fixture, [], true);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
