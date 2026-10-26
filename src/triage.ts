import * as fs from 'fs';
import { Cause, causeToFinding, causesExplanation, causesHeadline, groupErrors, isUnrecognised } from './causes';
import { bestErrors, readEvidence } from './evidence';
import { redact } from './redact';
import { Category, Finding, JobDetail, Triage } from './types';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export { redact };

export interface Rule {
  re: RegExp;
  build: (m: RegExpExecArray) => Finding;
}

const num = (s: string | undefined): number | undefined => (s ? parseInt(s, 10) : undefined);

const RULES: Rule[] = [
  // ---- Copado quality-gate messages (acceptance criteria text on failed Test / PMD jobs) ----
  {
    re: /code coverage is below the expected threshold of (?<need>\d+(?:\.\d+)?)\s*%/i,
    build: (m) => ({ category: 'coverage', message: `Quality gate: code coverage is below ${m.groups?.need}% (per-class numbers are in the test Result record)` }),
  },
  {
    re: /No unit test method can fail/i,
    build: () => ({ category: 'apex-test', message: 'Quality gate: at least one unit test method is failing (test names are in the test Result record)' }),
  },
  {
    re: /No unit test method can be skipped/i,
    build: () => ({ category: 'apex-test', message: 'Quality gate: some unit test methods were skipped' }),
  },
  {
    re: /at least one passing method/i,
    build: () => ({ category: 'apex-test', message: 'Quality gate: no unit test method passed' }),
  },
  {
    re: /PMD test failed\.?\s*(?<m>.+)/i,
    build: (m) => ({ category: 'quality-gate', message: `PMD quality gate: ${(m.groups?.m ?? '').replace(/[\\"'\s}\],]+$/g, '').replace(/\s+/g, ' ').trim()}` }),
  },

  // force-app/.../Foo.cls  Variable does not exist: x (45:13)   |   Foo.cls -- msg (line 45, column 13)
  {
    re: /^(?:\s*error[:\s]+)?(?<path>[\w./\\-]+\.(?:cls|trigger|[a-z]+-meta\.xml|page|component|cmp|js))[\s:–-]+(?<msg>.+?)\s*\((?:line\s*)?(?<line>\d+)\s*[,:]\s*(?:column\s*)?(?<col>\d+)\)\s*$/i,
    build: (m) => {
      const path = m.groups?.path ?? '';
      const msg = m.groups?.msg ?? '';
      const category: Category = /\.(cls|trigger)$/i.test(path)
        ? 'apex-compile'
        : /flow-meta\.xml$/i.test(path)
          ? 'flow'
          : /(no .* named|does not exist|not found)/i.test(msg)
            ? 'missing-dependency'
            : 'other';
      return { category, component: path, line: num(m.groups?.line), column: num(m.groups?.col), message: msg };
    },
  },
  // Table layout, name only:  "Error  DemoBroken  Variable does not exist: undefinedVar (4:20)"
  {
    re: /^\s*(?:error\s+)?(?<name>[A-Za-z_]\w*)\s{2,}(?<msg>\S.*?)\s*\((?<line>\d+):(?<col>\d+)\)\s*$/i,
    build: (m) => {
      const msg = m.groups?.msg ?? '';
      const compile = /(does not exist|unexpected token|expecting|illegal|invalid|missing|incorrect signature|duplicate|not return|compile|undeclared|cannot|not defined|must be)/i.test(msg);
      return { category: compile ? 'apex-compile' : 'other', component: m.groups?.name, line: num(m.groups?.line), column: num(m.groups?.col), message: msg };
    },
  },
  // Table layout, tests:  "DemoMathTest  addsTwoNumbers  System.AssertException: ...  Class.DemoMathTest.addsTwoNumbers: line 5, column 1"
  {
    re: /^\s*(?<cls>[A-Z]\w*)\s{2,}(?<method>[a-z]\w*)\s{2,}(?<msg>\S.*?(?:Exception|Assertion)[^\n]*?)(?:\s{2,}Class\.[\w.$]+:\s*line\s*(?<line>\d+),\s*column\s*(?<col>\d+))?\s*$/,
    build: (m) => ({
      category: 'apex-test',
      component: `${m.groups?.cls}.${m.groups?.method}`,
      line: num(m.groups?.line),
      column: num(m.groups?.col),
      message: m.groups?.msg ?? '',
    }),
  },
  // PaymentCalculatorTest.testX -- System.AssertException: ... -- Class.PaymentCalculatorTest.testX: line 31, column 1
  {
    re: /^\s*(?:(?:fail|failed|error)[:\s-]+)?(?<cls>[A-Z]\w*)\.(?<method>[a-z]\w*)(?:\s*(?:--|:|-)\s*|\s{2,})(?<msg>.*?(?:Exception|Assertion|assert|Expected|expected)[^\n]*?)(?:\s*(?:--)?\s*Class\.[\w.$]+:\s*line\s*(?<line>\d+),\s*column\s*(?<col>\d+))?\s*$/,
    build: (m) => ({
      category: 'apex-test',
      component: `${m.groups?.cls}.${m.groups?.method}`,
      line: num(m.groups?.line),
      column: num(m.groups?.col),
      message: m.groups?.msg ?? '',
    }),
  },
  {
    re: /(?:average\s+)?(?:test\s+|code\s+)coverage[^\n]*?\b(?<have>\d+(?:\.\d+)?)\s*%[^\n]*?(?:at least|minimum|required|below)[^\d\n]*(?<need>\d+(?:\.\d+)?)\s*%/i,
    build: (m) => ({
      category: 'coverage',
      message: `Apex test coverage is ${m.groups?.have}% but ${m.groups?.need}% is required`,
    }),
  },
  {
    re: /\bno\s+(?<kind>[A-Z]\w+)\s+named:?\s*(?<name>[\w.:-]+?)\s+found/i,
    build: (m) => ({
      category: 'missing-dependency',
      component: m.groups?.name,
      message: `${m.groups?.kind} ${m.groups?.name} was not found in the target`,
    }),
  },
  {
    re: /SObject row was retrieved via SOQL without querying the requested field:?\s*(?<name>[\w.]+)/i,
    build: (m) => ({
      category: 'permissions',
      component: m.groups?.name,
      message: `Field ${m.groups?.name} was not readable when queried (often field-level security)`,
    }),
  },
  {
    re: /(insufficient[_ ]access|not editable|is not accessible|FIELD_INTEGRITY_EXCEPTION|unknown user permission|field[- ]level security)/i,
    build: (m) => ({ category: 'permissions', message: m.input.trim() }),
  },
  {
    re: /(FIELD_CUSTOM_VALIDATION_EXCEPTION|REQUIRED_FIELD_MISSING|STRING_TOO_LONG)[:\s]*(?<msg>.*)/,
    build: (m) => ({ category: 'validation', message: m.input.trim() }),
  },
  {
    re: /duplicate (?:value found|developer name|child relationship name|label)[^\n]*/i,
    build: (m) => ({ category: 'duplicate', component: /\b\w+__[cr]\b/.exec(m[0])?.[0], message: m[0].trim() }),
  },
  {
    re: /(?=.*\bflow\b)(?=.*(?:exception|fault|error|failed))/i,
    build: (m) => ({ category: 'flow', component: /flow[:\s]+([A-Za-z]\w+)/i.exec(m.input)?.[1], message: m.input.trim() }),
  },
];

const NOISE = /^(deployment failed|deploy(ing)?|component failures|test failures|status|error)\b/i;

export function extractFindings(log: string, max = 8, rules: Rule[] = RULES): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<string>();
  const push = (f: Finding): void => {
    const key = `${f.category}|${f.component ?? ''}|${f.line ?? ''}|${f.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ ...f, message: clip(f.message, 300) });
    }
  };

  const unmatched: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let matched = false;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (m) {
        push(r.build(m));
        matched = true;
        break;
      }
    }
    if (!matched && /\b(error|exception|failed)\b/i.test(line) && !NOISE.test(line.trim())) unmatched.push(line.trim());
  }
  if (!found.length) for (const l of unmatched.slice(0, 3)) push({ category: 'other', message: l });
  return found.slice(0, max);
}

const LABEL: Record<Category, string> = {
  'apex-compile': 'Apex compile error',
  'apex-test': 'Apex test failure',
  coverage: 'coverage shortfall',
  'missing-dependency': 'missing dependency',
  permissions: 'permission/FLS problem',
  validation: 'validation error',
  flow: 'Flow error',
  duplicate: 'duplicate metadata',
  'quality-gate': 'quality gate failure',
  other: 'other error',
};

/** Generic guidance per category. Hints, not claims about this specific failure. */
export const HINT: Record<Category, string> = {
  'apex-compile':
    'Often a mismatch between promoted code and the target (a method or variable exists on one side only). Check the dependency is in this promotion or already deployed.',
  'apex-test': 'A test assertion failed. Compare expected vs actual and check whether logic or test data changed in this promotion.',
  coverage: 'Add or fix tests for the changed classes, or include the missing test classes in the promotion.',
  'missing-dependency': 'A referenced component is not in the target or this promotion. Add it to a story in the promotion or deploy it first.',
  permissions: 'Often field-level security or a profile/permission set missing the field or permission. Check the Admin profile and permission sets in this promotion.',
  validation: 'A validation rule or required field blocked the operation. Check recent rule changes.',
  flow: 'A Flow failed at activation or runtime. Check the Flow version and the fields it references.',
  duplicate: 'The same metadata exists twice (for example a duplicate relationship name). Remove it from one of the stories.',
  'quality-gate': 'A quality check configured on your pipeline failed. Fix what it reports for this story (for example PMD violations), then re-run the check.',
  other: 'See the log excerpt.',
};

export function headline(f: Finding[]): string {
  if (!f.length) return 'Failed, but no recognizable error pattern was found in the log';
  const counts = new Map<Category, number>();
  for (const x of f) counts.set(x.category, (counts.get(x.category) ?? 0) + 1);
  const parts = [...counts].map(([c, n]) => `${n} ${LABEL[c]}${n > 1 ? 's' : ''}`);
  return `${f.length} problem${f.length > 1 ? 's' : ''}: ${parts.join(', ')}`;
}

export function rulesExplanation(f: Finding[]): string {
  if (!f.length) return 'The job failed but the log has no known error pattern. Open the job log in Copado for details.';
  const cats = [...new Set(f.map((x) => x.category))];
  return cats.map((c) => `${LABEL[c][0].toUpperCase()}${LABEL[c].slice(1)}: ${HINT[c]}`).join('\n');
}

/** The failed step's log is the best evidence; fall back to everything. */
export function evidenceText(job: JobDetail): string {
  const failed = job.steps.filter((s) => s.state === 'failure').map((s) => s.log);
  const text = (failed.length ? failed : job.steps.map((s) => s.log)).concat(job.log).filter(Boolean).join('\n');
  return text;
}

export function excerpt(text: string, maxChars = 4000): string {
  const lines = text.split(/\r?\n/);
  const hot = lines.filter((l) => /(error|exception|fail|coverage|line \d+|\(\d+:\d+\)|no \w+ named)/i.test(l));
  return clip(redact((hot.length ? hot : lines.slice(-40)).slice(-60).join('\n')), maxChars);
}

export type AskFn = (prompt: string) => Promise<string | undefined>;

// ---------- custom rules (data, not code) ----------

export interface CustomRuleSpec {
  /** Regular expression source. Named groups `component`, `line`, `column`, `message` are used when present. */
  pattern: string;
  flags?: string;
  category: Category;
  component?: string;
  message?: string;
}

const CATEGORIES: Category[] = ['apex-compile', 'apex-test', 'coverage', 'missing-dependency', 'permissions', 'validation', 'flow', 'duplicate', 'quality-gate', 'other'];

/** Load extra rules from a JSON file so new log formats need no code change or rebuild. Invalid entries are reported, not silently skipped. */
export function loadCustomRules(file: string | undefined): { rules: Rule[]; problems: string[] } {
  const problems: string[] = [];
  if (!file || !fs.existsSync(file)) return { rules: [], problems };
  let specs: unknown;
  try {
    specs = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { rules: [], problems: [`${file}: not valid JSON (${(e as Error).message})`] };
  }
  const rules: Rule[] = [];
  (Array.isArray(specs) ? (specs as CustomRuleSpec[]) : []).slice(0, 50).forEach((sp, i) => {
    try {
      if (!sp || typeof sp.pattern !== 'string' || sp.pattern.length > 500) throw new Error('pattern missing or longer than 500 characters');
      if (!CATEGORIES.includes(sp.category)) throw new Error(`category must be one of ${CATEGORIES.join(', ')}`);
      const re = new RegExp(sp.pattern, sp.flags ?? 'i');
      rules.push({
        re,
        build: (m) => ({
          category: sp.category,
          component: m.groups?.component ?? sp.component,
          line: num(m.groups?.line),
          column: num(m.groups?.column),
          message: m.groups?.message ?? sp.message ?? m[0].trim(),
        }),
      });
    } catch (e) {
      problems.push(`${file} rule #${i + 1}: ${(e as Error).message}`);
    }
  });
  return { rules, problems };
}

// ---------- analysis ----------

export interface AnalyzeOptions {
  /** Extra pattern rules, tried before the built-in ones on free text. */
  rules?: Rule[];
}

export interface Analysis {
  headline: string;
  explanation: string;
  findings: Finding[];
  errorCount: number;
  stories: Record<string, string>;
  kinds: string[];
  /** Number of structured failures read from each source (for `triage --show`). */
  sources: { report: number; viewer: number; log: number; text: number };
  causes: Cause[];
  /** true when Copado cut the error text short: the last record was dropped and counts are a lower bound. */
  truncated: boolean;
  /** Leftover free text (first 6000 chars), for `triage --show`. */
  text: string;
}

/**
 * Turn any mix of deploy report JSON, Copado result JSON, function-log text or plain text into root causes.
 * Structured data is parsed structurally; pattern rules are only the last resort for unknown text.
 */
export function analyze(inputs: unknown[], opts: AnalyzeOptions = {}): Analysis {
  const ev = readEvidence(inputs);
  let errors = bestErrors(ev);
  // Copado cuts very long error messages off (e.g. mid-word: "...Field d"). The structured deploy report is never cut, but
  // the text sources can be. A short, unrecognisable last record in a long list is such a cut-off tail: drop it, say so.
  let truncated = false;
  if (!ev.report.length && errors.length >= 20) {
    const last = errors[errors.length - 1];
    if (last.problem.length <= 24 && !/[.:)\]'"]$/.test(last.problem) && isUnrecognised(last)) {
      errors = errors.slice(0, -1);
      truncated = true;
    }
  }
  const findings: Finding[] = [];
  const kinds = [...ev.kinds];
  let errorCount = 0;
  let causes: Cause[] = [];
  const parts: string[] = [];
  const expl: string[] = [];

  if (errors.length) {
    causes = groupErrors(errors);
    errorCount += errors.length;
    findings.push(...causes.map(causeToFinding));
    parts.push(causesHeadline(errors.length, causes));
    expl.push(causesExplanation(errors.length, causes));
    if (truncated) expl.push('Note: Copado cut the error text short, so the counts above are a lower bound. Re-validate after fixing to see anything that was hidden.');
  }
  for (const t of ev.testFailures) {
    findings.push({ category: 'apex-test', component: t.name, line: t.line, column: t.column, message: t.message });
  }
  for (const c of ev.coverage) findings.push({ category: 'coverage', message: c });
  errorCount += ev.testFailures.length + ev.coverage.length;
  if (ev.testFailures.length) {
    parts.push(`${ev.testFailures.length} test failure${ev.testFailures.length > 1 ? 's' : ''}`);
    expl.push(`Test failures: ${HINT['apex-test']}`);
  }
  if (ev.coverage.length) {
    parts.push(`${ev.coverage.length} coverage warning${ev.coverage.length > 1 ? 's' : ''}`);
    expl.push(`Coverage: ${HINT.coverage}`);
  }

  let text = 0;
  if (!findings.length) {
    const rf = extractFindings(ev.text, 50, [...(opts.rules ?? []), ...RULES]);
    if (rf.length) {
      kinds.push('pattern-rules');
      findings.push(...rf);
      errorCount = rf.length;
      text = rf.length;
      parts.push(headline(rf));
      expl.push(rulesExplanation(rf));
    }
  }
  return {
    headline: parts.join('; ') || headline([]),
    explanation: expl.join('\n\n') || rulesExplanation([]),
    findings,
    errorCount,
    stories: ev.stories,
    kinds,
    sources: { report: ev.report.length, viewer: ev.viewer.length, log: ev.log.length, text },
    causes,
    truncated,
    text: ev.text.slice(0, 6000),
  };
}

export function buildPrompt(job: JobDetail, findings: Finding[], logExcerpt: string): string {
  const list = findings
    .slice(0, 12)
    .map((f) => `- [${f.category}] ${f.component ?? ''}${f.line ? `:${f.line}` : ''} ${f.message}${f.count && f.count > 1 ? ` (${f.count} errors${f.affects?.length ? ` in ${f.affects.length} component(s)` : ''})` : ''}`)
    .join('\n');
  return [
    'You are a Salesforce release engineer assistant. A Copado job failed.',
    'Using ONLY the information below, explain in plain English (max 5 sentences) what failed, the most likely cause, and the first fix to try.',
    'If unsure, say so. Do not invent component names.',
    '',
    `Job: ${job.name} (${job.status})`,
    'Root causes:',
    list || '(none extracted)',
    '',
    'Log excerpt:',
    logExcerpt,
  ].join('\n');
}

export async function triage(job: JobDetail, ask?: AskFn, opts: AnalyzeOptions = {}): Promise<Triage> {
  const text = evidenceText(job);
  // The raw JSON holds everything (including embedded deploy reports); fall back to the joined step text.
  let a = job.raw !== undefined ? analyze([job.raw], opts) : analyze([text], opts);
  if (!a.findings.length) a = analyze([text], opts);
  const base: Triage = {
    headline: a.headline,
    explanation: a.explanation,
    findings: a.findings,
    errorCount: a.errorCount,
    stories: a.stories,
    kinds: a.kinds,
    truncated: a.truncated || undefined,
    source: 'rules',
  };
  if (!ask) return base;
  const answer = await ask(buildPrompt(job, a.findings, excerpt(text)));
  if (!answer) return base;
  return { ...base, explanation: clip(redact(answer).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''), 1500), source: 'ai+rules' };
}
