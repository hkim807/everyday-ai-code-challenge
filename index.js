// Pitchside kickoff verification - entry point.
//
// Pipeline per fixture: fetch evidence -> LLM extraction -> normalize to UTC ->
// classify (trust tier + freshness) -> deterministic verdict. Results are ranked
// and written to a skimmable report. The tool only ever recommends; a human
// applies changes to the feed.
//
// Run: `npm start` (or `node index.js`). Force the evidence-unavailable path for
// a fixture with `FORCE_EVIDENCE_FAILURE_ID=fx-2203 node index.js`.

import { existsSync, readFileSync } from "node:fs";

import { API_BASE_URL } from "./src/config.js";
import { fetchEvidenceForFixture, fetchJson } from "./src/api.js";
import { extractEvidenceForFixture } from "./src/extraction.js";
import { normalizeExtractionToUtc } from "./src/normalize.js";
import { classifyNormalizedCandidates } from "./src/classify.js";
import { classifyVerdict } from "./src/verdict.js";
import { writeReport } from "./src/report.js";

// Minimal .env loader (avoids a dependency). Called first so every later
// process.env read - OPENAI_API_KEY, OPENAI_MODEL, FORCE_EVIDENCE_FAILURE_ID -
// sees the loaded values.
function loadDotEnv(path = ".env") {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

async function main() {
  loadDotEnv();

  const fixtures = await fetchJson(`${API_BASE_URL}/fixtures`);
  const fixtureList = Array.isArray(fixtures) ? fixtures : fixtures.fixtures ?? [];

  const assessedItems = [];
  for (const fixture of fixtureList) {
    assessedItems.push(await assessFixture(fixture));
  }

  writeReport(assessedItems);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
