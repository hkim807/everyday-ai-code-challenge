import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";

const API_BASE_URL =
  "https://everyday-sim-463015353641.us-east1.run.app/api/challenge";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const FORCED_FAILURE_FIXTURE_ID = process.env.FORCE_EVIDENCE_FAILURE_ID;
const RUN_EXTRACTION = process.env.RUN_EXTRACTION === "1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

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
    parsed_directly: false,
    ...JSON.parse(response.output_text),
  });
}

async function printExtractions(fixture, evidence) {
  console.log(`\n=== Extraction results for fixture ${fixture.id} ===`);

  for (const item of evidenceItems(evidence)) {
    const extraction = await extractKickoffFromEvidence(item, fixture);
    console.dir(extraction, { depth: null });
  }
}

async function main() {
  loadDotEnv();

  const fixtures = await fetchJson(`${API_BASE_URL}/fixtures`);
  const fixtureList = Array.isArray(fixtures) ? fixtures : fixtures.fixtures ?? [];

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

    if (RUN_EXTRACTION && !evidence.evidence_unavailable) {
      await printExtractions(fixture, evidence);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
