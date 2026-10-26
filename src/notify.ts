import { Success } from './describe';
import { revalidateLabel } from './revalidate';
import { buildFailureBlocks, buildInfoBlocks, buildSuccessBlocks, ownerLabel, postJson } from './slack';
import { FailureReport } from './types';

export interface Notifier {
  failure(r: FailureReport): Promise<void>;
  success(s: Success): Promise<void>;
  info(text: string): Promise<void>;
}

const plain = (s: string): string => s.replace(/<@(\w+)>/g, '@$1').replace(/[*`]/g, '');

/** Prints the same content the Slack card would carry. Used for demos and when no webhook is set. */
export class ConsoleNotifier implements Notifier {
  constructor(private out: (s: string) => void = (s) => console.log(s)) {}
  async failure(r: FailureReport): Promise<void> {
    const L = [
      '',
      '┌──────────────────────────────────────────────────────────────',
      `│ JOB FAILED: ${r.job.name}   [${r.job.status}]  id=${r.job.id}`,
      ...(r.job.story || r.job.promotion ? [`│ ${[r.job.story ? `Story: ${r.job.story}` : '', r.job.promotion ? `Promotion: ${r.job.promotion}` : ''].filter(Boolean).join('   ')}`] : []),
      `│ ${r.triage.headline}`,
    ];
    for (const line of r.triage.explanation.split('\n')) L.push(`│   ${line}`);
    if (r.triage.findings.length) L.push('│ Root causes:');
    for (const f of r.triage.findings.slice(0, 6)) {
      const cnt = f.count && f.count > 1 ? `  (${f.count} errors${f.affects && f.affects.length > 1 ? ` in ${f.affects.length} components` : ''})` : '';
      L.push(`│   - ${[f.component ? `${f.component}${f.line ? `:${f.line}` : ''}` : '', f.message].filter(Boolean).join(' ')}${cnt}`);
    }
    if (r.owners.length) L.push('│ Story / owner:');
    for (const o of r.owners) L.push(`│   - ${o.component} -> ${plain(ownerLabel(o.owner))}`);
    L.push(`│ Explanation source: ${r.triage.source === 'ai+rules' ? 'AI (verify)' : 'rules'}`);
    const commit = r.commitAction ? ` [Commit ${r.commitAction.components.length} missing component${r.commitAction.components.length > 1 ? 's' : ''} to ${r.commitAction.story}]` : '';
    const reval = r.revalidateAction ? ` [${revalidateLabel(r.revalidateAction)}]` : '';
    L.push(`│ [Recommended fix]${commit}${reval}${r.hideRerun ? '' : ' [Re-run job]'}   (buttons appear in Slack)`);
    L.push('└──────────────────────────────────────────────────────────────');
    this.out(L.join('\n'));
  }
  async success(s: Success): Promise<void> {
    const tag = s.emoji === ':rocket:' ? '[DEPLOYED]' : '[OK]';
    this.out(`${tag} ${s.title}${s.detail ? `: ${s.detail}` : ''}${s.meta ? `   (${s.meta})` : ''}${s.links.length ? `\n     ${s.links.map((l) => `${l.label}: ${l.url}`).join('   ')}` : ''}${s.buttons?.length ? `\n     Buttons: ${s.buttons.map((b) => `[${b.label}]`).join(' ')}` : ''}`);
  }
  async info(text: string): Promise<void> {
    this.out(text);
  }
}

export class SlackNotifier implements Notifier {
  constructor(
    private webhook: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async failure(r: FailureReport): Promise<void> {
    await postJson(this.webhook, buildFailureBlocks(r), this.fetchImpl);
  }
  async success(s: Success): Promise<void> {
    await postJson(this.webhook, buildSuccessBlocks(s), this.fetchImpl);
  }
  async info(text: string): Promise<void> {
    await postJson(this.webhook, buildInfoBlocks(text), this.fetchImpl);
  }
}

/** Collects results instead of sending them (used by `once --notifier json` so agents get structured output). */
export class CollectNotifier implements Notifier {
  failures: FailureReport[] = [];
  successes: Success[] = [];
  infos: string[] = [];
  async failure(r: FailureReport): Promise<void> {
    this.failures.push(r);
  }
  async success(s: Success): Promise<void> {
    this.successes.push(s);
  }
  async info(text: string): Promise<void> {
    this.infos.push(text);
  }
  toJSON(): { failures: FailureReport[]; successes: Array<{ title: string; detail: string; meta: string; job: Success['job'] }>; info: string[] } {
    return { failures: this.failures, successes: this.successes.map((s) => ({ title: s.title, detail: s.detail, meta: s.meta, job: s.job })), info: this.infos };
  }
}
