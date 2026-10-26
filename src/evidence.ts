/**
 * Reads the three artifacts Copado attaches to a deployment job's Result record, plus plain text:
 *  1. deploy report JSON   (`sf project deploy report --json`: result.details.componentFailures[], runTestResult)
 *  2. Copado result viewer (`{data:[{Level,Category,Message}]}`, errors as "Type:Name:Problem" lines)
 *  3. function log text    ("Metadata list as JSON: [{u:story,t:type,n:name}]", "Metadata Validation - Type:Name:Problem")
 * Structured sources are parsed structurally (no regex guessing). Everything else becomes `text` for the rules.
 */
export interface RawError {
  type?: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  problem: string;
}

export interface TestFailure {
  name: string;
  message: string;
  line?: number;
  column?: number;
}

export interface Evidence {
  /** Errors by source. Only the best source is used, so the same error is never counted twice. */
  report: RawError[];
  viewer: RawError[];
  log: RawError[];
  testFailures: TestFailure[];
  coverage: string[];
  /** component name -> story id (from Copado's "Metadata list as JSON"). */
  stories: Record<string, string>;
  /** Free text left over for the pattern rules. */
  text: string;
  kinds: string[];
}

export const emptyEvidence = (): Evidence => ({
  report: [], viewer: [], log: [], testFailures: [], coverage: [], stories: {}, text: '', kinds: [],
});

const MAX_STRINGS = 2_000_000;
const note = (e: Evidence, k: string): void => {
  if (!e.kinds.includes(k)) e.kinds.push(k);
};
const toNum = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// ---------- text ----------

const TS_PREFIX = /^\d{2}:\d{2}:\d{2}\t/;
/** "ApexClass:Name:problem" anywhere in a line (also after "Metadata Validation - "). */
const TYPED = /(?:^|[\s-])(?<type>[A-Z][a-z]+(?:[A-Z][A-Za-z]*)*):(?<name>[A-Za-z_][\w.$]*):(?<problem>\S.*)$/;
/** SOQL error blocks continue over several lines after the typed line. */
const CONTINUATION = /^\s*(\^|ERROR at Row|SELECT\b|FROM\b|WHERE\b|No such column|Unknown field|Invalid\b)/i;

/**
 * Parse "Type:Name:Problem" records. Logs often print the same error list several times (a multi-line
 * list, then again as one long line, ...). A "block" is either a run of consecutive record lines, or a single
 * physical line holding several records; we keep the largest block so copies of one list are counted once.
 */
export function parseTypedLines(text: string): RawError[] {
  const blocks: RawError[][] = [];
  let run: RawError[] = [];
  let last: RawError | undefined;
  let cont = 0;
  const flush = (): void => {
    if (run.length) blocks.push(run);
    run = [];
    last = undefined;
  };
  const feed = (line: string, into: RawError[]): void => {
    const m = TYPED.exec(line);
    if (m?.groups) {
      last = { type: m.groups.type, name: m.groups.name, problem: m.groups.problem.trim() };
      into.push(last);
      cont = 0;
    } else if (last && cont < 6 && CONTINUATION.test(line)) {
      last.problem += ` ${line.trim()}`;
      cont++;
    } else {
      last = undefined;
    }
  };

  for (const physical of text.split(/\r?\n/)) {
    const line = physical.replace(TS_PREFIX, '');
    // Some systems store newlines as a literal backslash-n; split only where a new record starts.
    const parts = line.replace(/\\n(?=[A-Z][A-Za-z]+:[A-Za-z_])/g, '\n').split('\n');
    if (parts.length > 1) {
      flush();
      const own: RawError[] = [];
      for (const part of parts) feed(part, own);
      last = undefined;
      if (own.length) blocks.push(own);
    } else {
      feed(line, run);
      if (!last && run.length && !CONTINUATION.test(line)) {
        // a non-record, non-continuation line ends the run
        if (!TYPED.test(line)) flush();
      }
    }
  }
  flush();
  return blocks.reduce<RawError[]>((best, b) => (b.length > best.length ? b : best), []);
}

/**
 * Copado's "Metadata Deployment" errors for failed Apex tests:
 *   "Metadata Deployment - SomeTest-testMethod-System.DmlException: Insert failed. ...; Please check the logs for details."
 * The same message often appears twice in one job (job level and step level), so exact repeats are folded.
 */
const DEPLOY_FAIL = /(?<cls>[A-Z]\w*)-(?<method>[A-Za-z_]\w*)-(?<exc>(?:[A-Za-z]+\.)*[A-Za-z]+(?:Exception|Error)):\s*(?<msg>\S.*)$/;

export function parseDeployFailures(text: string): RawError[] {
  const out: RawError[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = DEPLOY_FAIL.exec(raw.replace(TS_PREFIX, ''));
    if (!m?.groups) continue;
    const problem = `${m.groups.exc}: ${m.groups.msg.trim()}`;
    const key = `${m.groups.cls}.${m.groups.method}|${problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'ApexTest', name: `${m.groups.cls}.${m.groups.method}`, problem });
  }
  return out;
}

function fromText(text: string, e: Evidence): void {
  for (const line of text.split(/\r?\n/)) {
    const m = /Metadata list as JSON:\s*(\[.*\])\s*$/.exec(line.replace(TS_PREFIX, ''));
    if (!m) continue;
    try {
      for (const it of JSON.parse(m[1]) as Array<{ u?: string; n?: string }>) if (it.u && it.n) e.stories[it.n] = it.u;
      note(e, 'copado-function-log');
    } catch {
      /* not valid JSON: ignore */
    }
  }
  const typed = [...parseTypedLines(text), ...parseDeployFailures(text)];
  if (typed.length) {
    e.log.push(...typed);
    note(e, 'log-text');
  }
  e.text += `${text}\n`;
}

// ---------- JSON ----------

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(v: Json, visit: (key: string | undefined, val: Json) => void, key?: string, depth = 0): void {
  if (depth > 14) return;
  visit(key, v);
  if (typeof v === 'string') {
    const s = v.trimStart();
    // JSON embedded in a string field (e.g. a step "result" holding the deploy report)
    if (s.length > 20 && (s[0] === '{' || s[0] === '[') && /componentFailures|runTestResult|"Message"/.test(v)) {
      try {
        walk(JSON.parse(v), visit, key, depth + 1);
      } catch {
        /* plain string */
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v.slice(0, 5000)) walk(x, visit, undefined, depth + 1);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) walk(x, visit, k, depth + 1);
  }
}

const asArray = (v: Json): Json[] => (Array.isArray(v) ? v : isObj(v) ? [v] : []);

function fromJson(root: Json, e: Evidence): void {
  let structured = false;
  const strings: string[] = [];
  let size = 0;
  walk(root, (key, val) => {
    if (typeof val === 'string' && size < MAX_STRINGS) {
      strings.push(val);
      size += val.length;
    }
    if (key === 'componentFailures') {
      for (const f of asArray(val)) {
        if (!isObj(f) || typeof f.problem !== 'string') continue;
        e.report.push({
          type: typeof f.componentType === 'string' ? f.componentType : undefined,
          name: typeof f.fullName === 'string' ? f.fullName : undefined,
          file: typeof f.fileName === 'string' ? f.fileName : undefined,
          line: toNum(f.lineNumber),
          column: toNum(f.columnNumber),
          problem: f.problem,
        });
      }
      structured = true;
      note(e, 'deploy-report');
    } else if (key === 'runTestResult' && isObj(val)) {
      for (const f of asArray(val.failures)) {
        if (!isObj(f)) continue;
        const stack = typeof f.stackTrace === 'string' ? f.stackTrace : '';
        const pos = /line (\d+), column (\d+)/.exec(stack);
        e.testFailures.push({
          name: `${String(f.name ?? 'Test')}.${String(f.methodName ?? '')}`.replace(/\.$/, ''),
          message: String(f.message ?? ''),
          line: pos ? toNum(pos[1]) : undefined,
          column: pos ? toNum(pos[2]) : undefined,
        });
      }
      for (const w of asArray(val.codeCoverageWarnings)) if (isObj(w) && typeof w.message === 'string') e.coverage.push(w.message);
      structured = true;
      note(e, 'deploy-report');
    } else if (key === 'data' && Array.isArray(val) && val.some((x) => isObj(x) && typeof x.Message === 'string')) {
      for (const entry of val) {
        if (!isObj(entry) || typeof entry.Message !== 'string') continue;
        if (/^error/i.test(String(entry.Level ?? ''))) {
          const typed = parseTypedLines(entry.Message);
          e.viewer.push(...typed);
          e.text += `${entry.Message}\n`;
        }
      }
      structured = true;
      note(e, 'copado-result');
    }
  });
  if (!structured) {
    const text = strings.join('\n');
    if (text) fromText(text, e);
  } else {
    // Stories can still be present in sibling text fields
    for (const s of strings) if (s.includes('Metadata list as JSON')) fromText(s, e);
  }
}

// ---------- entry point ----------

/** Accepts parsed JSON, JSON text, or plain log text, in any mix. */
export function readEvidence(inputs: Json[]): Evidence {
  const e = emptyEvidence();
  for (const input of inputs) {
    if (input === undefined || input === null) continue;
    if (typeof input === 'string') {
      const t = input.replace(/^\uFEFF/, '');
      const start = t.search(/[[{]/);
      if (start >= 0 && start < 300) {
        try {
          fromJson(JSON.parse(t.slice(start)), e);
          continue;
        } catch {
          /* fall through: it is text */
        }
      }
      fromText(t, e);
    } else {
      fromJson(input, e);
    }
  }
  return e;
}

/** Use the richest source only, so the same error is never counted twice. */
export function bestErrors(e: Evidence): RawError[] {
  return e.report.length ? e.report : e.viewer.length ? e.viewer : e.log;
}
