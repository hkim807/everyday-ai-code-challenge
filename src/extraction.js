// LLM extraction layer. This is the ONLY module that talks to OpenAI - by
// design. The model's job is narrow: pull structured candidate facts out of
// messy social/web text. It never decides trust, freshness, or a verdict; that
// is deterministic code downstream. ScoreFeed listings are already structured,
// so they are parsed directly without an LLM call.

import OpenAI from "openai";

import { DEFAULT_OPENAI_MODEL, extractionResponseFormat } from "./config.js";
import { evidenceItems } from "./api.js";

let openaiClient;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required for extraction. Set it in .env or the environment and rerun.",
    );
  }

  openaiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

// Only send the model the fields it needs to reason about a single item.
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

// ScoreFeed is clean and structured - parse it directly, no LLM call. Keep it as
// UTC for the normalizer; trust tiering happens later.
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

// Source provenance is preserved from the raw evidence so tiering stays
// deterministic and is never something the LLM can influence.
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
    evidence_timestamp:
      item.retrieved_at ?? item.fetched_at ?? item.posted_at ?? null,
  };
}

function normalizeNullableString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.trim().toLowerCase() === "null" ? null : value;
}

// Defensive belt-and-braces: even if the model returns a time, drop it unless it
// also confirmed the item is about this fixture and is actually a kickoff.
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
      extraction_confidence_note: "Unsupported evidence type for extraction.",
    };
  }

  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
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

export async function extractEvidenceForFixture(fixture, evidence) {
  const extractions = [];

  for (const item of evidenceItems(evidence)) {
    extractions.push(await extractKickoffFromEvidence(item, fixture));
  }

  return extractions;
}
