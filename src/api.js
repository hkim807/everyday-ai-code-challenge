// HTTP layer for the challenge API. The evidence endpoint sits behind an older
// gateway that returns intermittent 503s and can be slow, so every request gets
// a timeout plus bounded retries with exponential backoff. A fixture whose
// evidence cannot be fetched is reported as `evidence_unavailable` rather than
// crashing the whole run.

import {
  API_BASE_URL,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
} from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error) {
  return error.name === "AbortError" || error.status === 503;
}

export async function fetchJson(url, options = {}) {
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

export async function fetchEvidenceForFixture(fixtureId) {
  try {
    // Test hook: FORCE_EVIDENCE_FAILURE_ID lets us exercise the unavailable
    // path deterministically without waiting for a real gateway 503.
    if (fixtureId === process.env.FORCE_EVIDENCE_FAILURE_ID) {
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

// The evidence endpoint returns `{ fixture_id, evidence: [...] }`, but stay
// tolerant of a bare array or an `items` envelope.
export function evidenceItems(evidencePayload) {
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
