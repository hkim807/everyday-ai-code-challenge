const API_BASE_URL =
  "https://everyday-sim-463015353641.us-east1.run.app/api/challenge";

const SAMPLE_FIXTURE_COUNT = 3;

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
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
  const selectedFixtures = fixtureList.slice(0, SAMPLE_FIXTURE_COUNT);

  console.log("=== Fixtures payload ===");
  console.dir(fixtures, { depth: null });
  console.log("\n=== Fixture field names observed ===");
  console.dir(summarizeFieldNames(fixtureList), { depth: null });

  for (const fixture of selectedFixtures) {
    const fixtureId = fixture.id;
    const evidence = await fetchJson(`${API_BASE_URL}/fixtures/${fixtureId}/evidence`);
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
