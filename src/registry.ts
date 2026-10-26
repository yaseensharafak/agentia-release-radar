import { FailureReport } from './types';

/** Reports we have announced, keyed by job id. Buttons may only act on jobs listed here. */
export class Registry {
  private m = new Map<string, FailureReport>();
  constructor(private max = 200) {}
  set(r: FailureReport): void {
    this.m.delete(r.job.id);
    this.m.set(r.job.id, r);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  get(id: string): FailureReport | undefined {
    return this.m.get(id);
  }
}
