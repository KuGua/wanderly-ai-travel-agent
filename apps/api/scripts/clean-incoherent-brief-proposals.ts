/**
 * One-off repair for brief proposals stored before the date-coherence guard.
 *
 * Until 2026-09, a trip's `pending_brief_proposal` could be assembled from two
 * sources that never checked each other: this codebase parsed the owner's own
 * words, and a model — with no idea what year it was — supplied whatever the
 * owner had accepted from the assistant. "10月1号到10月7号" became a start in
 * 2026 and an end in 2024. `PATCH /trips/:tripId/draft-brief` refuses that
 * pair, so the confirmation card answered 400 on every click, and refreshing
 * could not help: the pair lives on the trip. Those rows are still there.
 *
 * The same fault also landed on the other side of the write boundary. A pair
 * that agreed with itself but sat in the past — 2024-10-01/2024-10-01 —
 * validated and saved, giving the trip travel dates two years gone. Those are
 * REPORTED ONLY: a confirmed brief is a trip fact the creator owns, and
 * guessing a replacement year would be the same mistake in the other
 * direction. Fix them with the owner, in the app.
 *
 * Idempotent, and a dry run unless `--apply` is passed.
 *
 * Usage:
 *   DATABASE_URL=postgres://travelagent:travelagent@127.0.0.1:5432/travelagent \
 *     tsx scripts/clean-incoherent-brief-proposals.ts [--apply]
 */
import postgres from "postgres";

import {
  coherentBriefDates,
  type TripBriefProposal,
} from "../src/services/trip-brief-proposal-service.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const apply = process.argv.includes("--apply");

type ProposalRow = { id: string; name: string; pending_brief_proposal: TripBriefProposal };
type PastDateRow = { id: string; name: string; status: string; travel_date_start: string; travel_date_end: string | null };

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1 });
  const now = new Date();
  try {
    const proposals = await sql<ProposalRow[]>`
      SELECT id, name, pending_brief_proposal
      FROM shared_trips
      WHERE pending_brief_proposal IS NOT NULL
    `;

    let repaired = 0;
    for (const row of proposals) {
      const { proposal, result } = coherentBriefDates(row.pending_brief_proposal, now);
      if (result === "ok") continue;
      repaired += 1;
      const next = Object.keys(proposal).length > 0 ? proposal : null;
      console.log(
        `[proposal] ${row.id} (${row.name}): ${result}`,
        `\n           before: ${JSON.stringify(row.pending_brief_proposal)}`,
        `\n           after:  ${JSON.stringify(next)}`,
      );
      if (apply) {
        await sql`
          UPDATE shared_trips
          SET pending_brief_proposal = ${next as never}, updated_at = now()
          WHERE id = ${row.id}
        `;
      }
    }

    // Reported, never rewritten — see the header.
    const today = now.toISOString().slice(0, 10);
    const pastDates = await sql<PastDateRow[]>`
      SELECT id, name, status, travel_date_start, travel_date_end
      FROM shared_trips
      WHERE travel_date_start IS NOT NULL AND travel_date_start < ${today}
      ORDER BY travel_date_start
    `;
    for (const row of pastDates) {
      console.log(
        `[past dates] ${row.id} (${row.name}, ${row.status}): `
        + `${row.travel_date_start} → ${row.travel_date_end ?? "—"} — review with the trip's creator`,
      );
    }

    console.log(
      `\n${apply ? "repaired" : "would repair"} ${repaired} of ${proposals.length} stored proposal(s); `
      + `${pastDates.length} trip(s) hold travel dates in the past.`,
    );
    if (!apply && repaired > 0) console.log("Re-run with --apply to write these changes.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
