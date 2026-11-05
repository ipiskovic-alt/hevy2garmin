import { NextResponse } from "next/server";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { repeatsEarlierRun } from "@/lib/sync-progress";
import { postgresSyncStore } from "@/lib/sync-store";
import { recordSyncRun } from "hevy2garmin";
import { getDb } from "@/lib/db";
import { acquireSyncLock } from "hevy2garmin";
import { postgresLockBackend } from "@/lib/sync-lock-store";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CAP = 50;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);

  if (!secret || !m || m[1] !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  let sqlForPat: ReturnType<typeof getDb> | null = null;
  try {
    sqlForPat = getDb();
  } catch {
    sqlForPat = null;
  }

  const pat = await getGithubPat(sqlForPat);
  const repo = getGithubRepo();

  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);
      return NextResponse.json(
        { ok, mode: "dispatch", triggered: ok },
        { status: ok ? 200 : 502 },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error }, { status: 502 });
    }
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `DB unavailable: ${error}` },
      { status: 503 },
    );
  }

  const lock = await acquireSyncLock({
    backend: postgresLockBackend(sql),
    key: "sync",
  });

  if (!lock) {
    return NextResponse.json({
      ok: true,
      mode: "skipped",
      reason: "another sync is running",
      ran: 0,
    });
  }

  const runs: SyncOneResult[] = [];
  const seen = new Set<string>();

  try {
    for (let i = 0; i < CAP; i++) {
      const r = await syncOneWorkout(sql, {
        dryRun: false,
        respectGrace: true,
      });

      if (r.status === "none") break;
      if (repeatsEarlierRun(seen, r)) break;

      runs.push(r);

      if (r.status === "error") break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error, ran: runs.length },
      { status: 500 },
    );
  } finally {
    await lock.release();
  }

  const status = (r: SyncOneResult) => r.status as string;

  const synced = runs.filter((r) => status(r) === "synced").length;

  const deferred = runs.filter(
    (r) =>
      status(r) === "deferred" ||
      status(r) === "skipped" ||
      status(r) === "processing",
  ).length;

  const failed = runs.filter(
    (r) => status(r) === "error" || status(r) === "failed",
  ).length;

  await recordSyncRun(
    postgresSyncStore(sql),
    { synced, skipped: deferred, failed },
    "cron",
  );

  return NextResponse.json({
    ok: true,
    mode: "inline",
    ran: runs.length,
    synced,
  });
}
