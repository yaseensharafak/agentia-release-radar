import { JobState, JobSummary } from './types';

export interface Transition {
  job: JobSummary;
  from?: JobState;
  to: JobState;
}

/** Remembers each job's last state and reports only changes. In-memory by design. */
export class JobTracker {
  private seen = new Map<string, { state: JobState; status: string }>();
  private primed = false;

  update(jobs: JobSummary[], opts: { includeExisting?: boolean } = {}): Transition[] {
    const out: Transition[] = [];
    const baseline = !this.primed && !opts.includeExisting;
    for (const job of jobs) {
      const prev = this.seen.get(job.id);
      const changed = !prev || prev.state !== job.state || prev.status !== job.status;
      if (changed && !baseline && (!prev || prev.state !== job.state)) {
        out.push({ job, from: prev?.state, to: job.state });
      }
      this.seen.set(job.id, { state: job.state, status: job.status });
    }
    this.primed = true;
    return out;
  }
}
