import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getGithubPat, getGithubRepo, triggerViaActions } from "@/lib/github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  let sql: ReturnType<typeof getDb> | null = null;

  try {
    sql = getDb();
  } catch {
    // GitHub PAT may still be available through environment variables.
  }

  const pat = await getGithubPat(sql);
  const repo = getGithubRepo();

  if (pat && repo) {
    try {
      const ok = await triggerViaActions(pat, repo);

      return NextResponse.json(
        { ok, mode: "dispatch", triggered: ok },
        { status: ok ? 200 : 502 }
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      return NextResponse.json(
        { ok: false, mode: "dispatch", error },
        { status: 502 }
      );
    }
  }

  return NextResponse.json(
    {
      ok: false,
      error: "GitHub Actions is not configured. Check GitHub PAT and repository settings.",
    },
    { status: 503 }
  );
}
