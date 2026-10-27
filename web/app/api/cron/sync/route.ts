```typescript
import { NextResponse } from "next/server";
import { syncOneWorkout, type SyncOneResult } from "@/lib/sync-one";
import { repeatsEarlierRun } from "@/lib/sync-progress";
import { postgresSyncStore } from "@/lib/sync-store";
import { recordSyncRun, acquireSyncLock } from "hevy2garmin";
import { getDb } from "@/lib/db";
import { postgresLockBackend } from "@/lib/sync-lock-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const CAP = 50;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!secret || !match || match[1] !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401 }
    );
  }

  let sql: ReturnType<typeof getDb>;

  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Database unavailable: ${error}` },
      { status: 503 }
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
      reason: "Another sync is running",
      ran: 0,
    });
  }

  const runs: SyncOneResult[] = [];
  const seen = new Set<string>();

  try {
    for (let i = 0; i < CAP; i++) {
      const result = await syncOneWorkout(sql, {
        dryRun: false,
        respectGrace: true,
      });

      if (result.status === "none") break;
      if (repeatsEarlierRun(seen, result)) break;

      runs.push(result);

      if (result.status === "error") break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    return NextResponse.json(
      { ok: false, error, ran: runs.length },
      { status: 500 }
    );
  } finally {
    await lock.release();
  }

  const status = (result: SyncOneResult) => result.status as string;

  const synced = runs.filter(
    (result) => status(result) === "synced"
  ).length;

  const skipped = runs.filter(
    (result) =>
      ["deferred", "skipped", "processing"].includes(status(result))
  ).length;

  const failed = runs.filter(
    (result) => ["error", "failed"].includes(status(result))
  ).length;

  await recordSyncRun(
    postgresSyncStore(sql),
    { synced, skipped, failed },
    "cron"
  );

  return NextResponse.json({
    ok: true,
    mode: "inline",
    ran: runs.length,
    synced,
    skipped,
    failed,
  });
}
```
