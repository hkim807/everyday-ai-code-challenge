const API_BASE_URL =
  "https://everyday-sim-463015353641.us-east1.run.app/api/challenge";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const FORCED_FAILURE_FIXTURE_ID = process.env.FORCE_EVIDENCE_FAILURE_ID;

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

async function main() {
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
