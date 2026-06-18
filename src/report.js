// Presentation layer: ranks the assessed fixtures, renders a skimmable console
// report and a markdown file, and writes the machine-readable JSON. Action-needed
// items (changes + flags) are ranked first by soonest kickoff so the analyst's
// limited daily attention lands on what matters most; quiet items follow.

import { writeFileSync } from "node:fs";
import { DateTime } from "luxon";

import { FRESHNESS_WINDOW_DAYS } from "./config.js";
import { utcMillis } from "./normalize.js";

function actionNeeded(verdict) {
  return (
    verdict.verdict === "Change recommended" ||
    verdict.verdict === "Flagged (needs review)"
  );
}

function kickoffMillis(fixture) {
  return utcMillis(fixture.kickoff_utc) ?? Number.MAX_SAFE_INTEGER;
}

// Tie-breaker within the same kickoff: surface the larger potential shift first
// (a 3-hour move is more dangerous to broadcasters than a 30-minute one).
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
    .map((receipt) => {
      const utc = receipt.candidate_kickoff_utc ?? "no time stated";
      const local = receipt.candidate_kickoff_time_local
        ? ` (${receipt.candidate_kickoff_time_local}${receipt.resolved_timezone ? ` ${receipt.resolved_timezone}` : ""})`
        : "";
      const who = receipt.source_handle ?? receipt.source_type;
      return `${receipt.source_id} → ${utc}${local} — ${who}, ${receipt.source_type}, posted ${receipt.evidence_timestamp ?? "no timestamp"}, tier ${receipt.trust_tier}, ${receipt.freshness}`;
    })
    .join("; ");
}

function candidateTimesText(verdict) {
  const times = verdict.candidate_kickoff_utc_values;
  if (!Array.isArray(times) || times.length === 0) {
    return null;
  }

  return times.join("  vs  ");
}

function renderConsoleSection(items) {
  for (const item of items) {
    console.log(
      `- ${item.fixture.id} ${formatFixtureName(item.fixture)} | ${item.verdict.verdict} | recommended: ${recommendedText(item.verdict)}`,
    );
    console.log(`  Why: ${item.verdict.why}`);
    if (candidateTimesText(item.verdict)) {
      console.log(`  Candidate times: ${candidateTimesText(item.verdict)}`);
    }
    console.log(`  Receipts: ${receiptText(item.verdict.receipts)}`);
  }
}

function renderConsoleReport(items) {
  console.log("\nPitchside Kickoff Verification Report");
  console.log(`Generated: ${DateTime.utc().toISO()}`);

  const actionItems = items.filter((item) => actionNeeded(item.verdict));
  console.log("\nAction needed");
  if (actionItems.length === 0) {
    console.log("  None");
  }
  renderConsoleSection(actionItems);

  console.log("\nQuiet roster");
  renderConsoleSection(items.filter((item) => !actionNeeded(item.verdict)));
}

function markdownItemLines(item) {
  return [
    `### ${item.fixture.id} - ${formatFixtureName(item.fixture)}`,
    "",
    `- Verdict: ${item.verdict.verdict}`,
    `- Current feed kickoff: ${item.fixture.kickoff_utc}`,
    `- Recommended: ${recommendedText(item.verdict)}`,
    `- Why: ${item.verdict.why}`,
    ...(candidateTimesText(item.verdict)
      ? [`- Candidate times: ${candidateTimesText(item.verdict)}`]
      : []),
    `- Receipts: ${receiptText(item.verdict.receipts)}`,
    "",
  ];
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
    lines.push(...markdownItemLines(item));
  }

  lines.push("## Quiet Roster", "");
  for (const item of items.filter((entry) => !actionNeeded(entry.verdict))) {
    lines.push(...markdownItemLines(item));
  }

  return `${lines.join("\n").trim()}\n`;
}

export function writeReport(assessedItems) {
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
