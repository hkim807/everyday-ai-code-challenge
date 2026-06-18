// Static configuration: API location, request resilience knobs, freshness
// policy, locale lookup tables, timezone aliases, and the LLM response schema.
// No environment variables are read here - those are read lazily at call time
// so `loadDotEnv()` (called first in main) always wins.

export const API_BASE_URL =
  "https://everyday-sim-463015353641.us-east1.run.app/api/challenge";

export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 500;

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// How recent evidence must be (relative to the run date) to count as "fresh".
// Stale evidence can never confirm or move a time - see NOTES.md.
export const FRESHNESS_WINDOW_DAYS = 14;

export const WEEKDAY_NUMBERS = new Map([
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

export const MONTH_NUMBERS = new Map([
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

// Maps stated timezone wording (incl. Spanish) to IANA zones, so Luxon applies
// the correct DST offset for the match date rather than a fixed offset.
export const ZONE_ALIASES = new Map([
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

export const extractionResponseFormat = {
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
