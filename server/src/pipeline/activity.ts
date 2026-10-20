// Per-seam refresh activity behind GET /api/status (plan §6, D24): lastSuccessAt / lastError from
// the refresh jobs' stages as each job finishes (the claude seam is the `extract` stage). lastError
// is the stage's error text, always one of the fixed content-free phrases of pipeline/errors.ts.
import {
  SEAMS,
  type RefreshStage,
  type RefreshStatus,
  type Seam,
  type SeamStatus,
} from "@yarvis/shared";

/** The refresh stage each seam's activity is read from. */
export const SEAM_STAGE: Readonly<Record<Seam, RefreshStage>> = {
  gmail: "gmail",
  whatsapp: "whatsapp",
  sheets: "sheets",
  jev: "jev",
  claude: "extract",
};

type Activity = Pick<SeamStatus, "lastSuccessAt" | "lastError">;

/**
 * Per-seam activity across the jobs this process ran: a `done` stage sets lastSuccessAt (the job's
 * finishedAt) and replaces lastError with the stage's per-item error, if any; an `error` stage sets
 * lastError and keeps the previous lastSuccessAt; a pending/skipped stage changes nothing.
 */
export class SeamActivity {
  private readonly activity = new Map<Seam, Activity>();

  record(status: RefreshStatus): void {
    if (status.state !== "done" && status.state !== "partial" && status.state !== "error") return;
    for (const seam of SEAMS) {
      const stage = status.stages[SEAM_STAGE[seam]];
      const prev = this.activity.get(seam) ?? {};
      if (stage.state === "done") {
        this.activity.set(seam, {
          ...(status.finishedAt
            ? { lastSuccessAt: status.finishedAt }
            : pick(prev, "lastSuccessAt")),
          ...(stage.error ? { lastError: stage.error } : {}),
        });
      } else if (stage.state === "error") {
        const lastError = stage.error ?? status.error;
        this.activity.set(seam, {
          ...pick(prev, "lastSuccessAt"),
          ...(lastError ? { lastError } : pick(prev, "lastError")),
        });
      }
    }
  }

  get(seam: Seam): Activity {
    return { ...this.activity.get(seam) };
  }
}

function pick(a: Activity, key: keyof Activity): Activity {
  return a[key] === undefined ? {} : { [key]: a[key] };
}
