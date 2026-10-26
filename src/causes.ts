import { RawError } from './evidence';
import { Category, Finding } from './types';

/**
 * One root cause behind many errors. In a real promotion, 261 compile errors came from 5 missing custom fields.
 * Grouping is what turns a wall of errors into something a human can act on.
 */
export interface Cause {
  key: string;
  kind: 'missing-field' | 'unknown-variable' | 'missing-type' | 'bad-method' | 'picklist-value' | 'required-field' | 'validation-rule' | 'test-assertion' | 'other';
  category: Category;
  label: string;
  field?: string;
  entity?: string;
  metadata?: { type: string; name: string };
  count: number;
  components: string[];
  sample: RawError;
}

interface Match {
  key: string;
  kind: Cause['kind'];
  category: Category;
  label: string;
  field?: string;
  entity?: string;
  metadata?: { type: string; name: string };
}

const PATTERNS: Array<{ re: RegExp; make: (m: RegExpExecArray) => Match }> = [
  {
    re: /No such column '(?<f>\w+)' on entity '(?<e>\w+)'/i,
    make: (m) => field(m.groups?.f ?? '', m.groups?.e ?? ''),
  },
  {
    re: /Field does not exist: (?<f>\w+) on (?<e>\w+)/i,
    make: (m) => field(m.groups?.f ?? '', m.groups?.e ?? ''),
  },
  {
    re: /Invalid field (?<f>\w+) for (?<e>\w+)/i,
    make: (m) => field(m.groups?.f ?? '', m.groups?.e ?? ''),
  },
  {
    re: /bad value for restricted picklist field:\s*(?<v>.+?):?\s*\[(?<f>\w+)\]/i,
    make: (m) => ({
      key: `picklist:${(m.groups?.f ?? '').toLowerCase()}:${(m.groups?.v ?? '').toLowerCase()}`,
      kind: 'picklist-value',
      category: 'missing-dependency',
      label: `Value "${(m.groups?.v ?? '').trim()}" is not an allowed picklist value for ${m.groups?.f}`,
      field: m.groups?.f,
    }),
  },
  {
    re: /REQUIRED_FIELD_MISSING,?\s*Required fields are missing:\s*\[(?<f>[^\]]+)\]/i,
    make: (m) => ({ key: `required:${(m.groups?.f ?? '').toLowerCase()}`, kind: 'required-field', category: 'validation', label: `Required field missing in test data: ${m.groups?.f}` }),
  },
  {
    re: /FIELD_CUSTOM_VALIDATION_EXCEPTION,?\s*(?<m>[^:\[]+)/i,
    make: (m) => ({ key: `val:${(m.groups?.m ?? '').trim().toLowerCase()}`, kind: 'validation-rule', category: 'validation', label: `A validation rule blocked the data: ${(m.groups?.m ?? '').trim()}` }),
  },
  {
    re: /Unable to find Apex action class referenced as '(?<c>[\w.]+)'/i,
    make: (m) => ({ key: `type:${(m.groups?.c ?? '').toLowerCase()}`, kind: 'missing-type', category: 'missing-dependency', label: `Missing Apex class ${m.groups?.c} (referenced by a Lightning component)`, metadata: { type: 'ApexClass', name: m.groups?.c ?? '' } }),
  },
  {
    re: /System\.AssertException:\s*(?<m>.+)/i,
    make: (m) => ({ key: `assert:${(m.groups?.m ?? '').replace(/\d+/g, '#').slice(0, 80).toLowerCase()}`, kind: 'test-assertion', category: 'apex-test', label: `Assertion failed: ${(m.groups?.m ?? '').slice(0, 140)}` }),
  },
  {
    re: /Variable does not exist: (?<v>[\w.]+)/i,
    make: (m) => {
      const v = m.groups?.v ?? '';
      // In Apex, calling a class that is not there (Foo.bar()) reports "Variable does not exist: Foo". A compound
      // PascalCase name (DiscountCalculatorService) is almost always a class, never a field, so suggest committing it.
      const looksLikeClass = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(v);
      return {
        key: `var:${v.toLowerCase()}`,
        kind: 'unknown-variable',
        category: 'apex-compile',
        label: looksLikeClass ? `Unknown name ${v} (looks like a missing Apex class)` : `Unknown variable ${v}`,
        field: v.split('.').pop(),
        metadata: looksLikeClass ? { type: 'ApexClass', name: v } : undefined,
      };
    },
  },
  {
    re: /Invalid type: (?<t>[\w.]+)/i,
    make: (m) => ({ key: `type:${(m.groups?.t ?? '').toLowerCase()}`, kind: 'missing-type', category: 'missing-dependency', label: `Missing type or class ${m.groups?.t}` }),
  },
  {
    re: /Method does not exist or incorrect signature: (?<m>[^\n]*?)(?: from the type (?<t>\w+))?\s*$/i,
    make: (m) => ({ key: `method:${(m.groups?.m ?? '').toLowerCase()}`, kind: 'bad-method', category: 'apex-compile', label: `Method not found: ${m.groups?.m}${m.groups?.t ? ` (on ${m.groups.t})` : ''}` }),
  },
];

function field(f: string, e: string): Match {
  return {
    key: `field:${e.toLowerCase()}.${f.toLowerCase()}`,
    kind: 'missing-field',
    category: 'missing-dependency',
    label: `Missing field ${e}.${f}`,
    field: f,
    entity: e,
    // Only custom fields can be committed from a dev org; standard fields are never "missing".
    metadata: /__c$/i.test(f) ? { type: 'CustomField', name: `${e}.${f}` } : undefined,
  };
}

const norm = (s: string): string => s.replace(/;?\s*Please check the logs for details\.?\s*$/i, '').replace(/\s+/g, ' ').trim();

function classify(e: RawError): Match {
  const problem = norm(e.problem);
  for (const p of PATTERNS) {
    const m = p.re.exec(problem);
    if (m) return p.make(m);
  }
  const generic = norm(problem.replace(/'[^']*'/g, "'…'").replace(/\d+/g, '#')).slice(0, 110);
  const category: Category = e.type === 'ApexTest' ? 'apex-test' : /^Apex/i.test(e.type ?? '') ? 'apex-compile' : 'other';
  return { key: `msg:${generic.toLowerCase()}`, kind: 'other', category, label: norm(problem).slice(0, 160) };
}

/** True when an error matches none of the known patterns (used to spot truncated trailing records). */
export const isUnrecognised = (e: RawError): boolean => classify(e).kind === 'other';

const isTestName = (n?: string): boolean => !!n && /test$/i.test(n);

export function groupErrors(errors: RawError[]): Cause[] {
  const map = new Map<string, Cause>();
  for (const e of errors) {
    const m = classify(e);
    const c = map.get(m.key);
    const comp = e.name ?? e.file ?? '';
    if (!c) {
      map.set(m.key, { ...m, count: 1, components: comp ? [comp] : [], sample: e });
    } else {
      c.count++;
      if (comp && !c.components.includes(comp)) c.components.push(comp);
      // prefer a sample from production code, with the earliest line, over a test class
      const better = (isTestName(c.sample.name) && !isTestName(e.name)) || (isTestName(c.sample.name) === isTestName(e.name) && (e.line ?? 1e9) < (c.sample.line ?? 1e9));
      if (better) c.sample = e;
    }
  }

  // "Variable does not exist: X" is usually the same missing field X seen from another angle: merge it.
  const fields = new Map<string, Cause>();
  for (const c of map.values()) if (c.kind === 'missing-field' && c.field) {
    const k = c.field.toLowerCase();
    const prev = fields.get(k);
    if (!prev || c.count > prev.count) fields.set(k, c);
  }
  for (const [key, c] of [...map]) {
    if (c.kind !== 'unknown-variable' || !c.field) continue;
    const target = fields.get(c.field.toLowerCase());
    if (!target) continue;
    target.count += c.count;
    for (const x of c.components) if (!target.components.includes(x)) target.components.push(x);
    map.delete(key);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** One representative Finding per root cause, carrying counts, so cards stay short. */
export function causeToFinding(c: Cause): Finding {
  return {
    metadata: c.metadata,
    category: c.category,
    component: c.sample.name ?? c.sample.file,
    line: c.sample.line,
    column: c.sample.column,
    message: c.label,
    count: c.count,
    affects: c.components,
  };
}

const KIND_LABEL: Record<Cause['kind'], [string, string]> = {
  'missing-field': ['missing field', 'missing fields'],
  'unknown-variable': ['unknown variable', 'unknown variables'],
  'missing-type': ['missing type', 'missing types'],
  'bad-method': ['unresolved method', 'unresolved methods'],
  'picklist-value': ['picklist value problem', 'picklist value problems'],
  'required-field': ['required-field problem', 'required-field problems'],
  'validation-rule': ['validation-rule problem', 'validation-rule problems'],
  'test-assertion': ['failed assertion', 'failed assertions'],
  other: ['other problem', 'other problems'],
};

/** One short, generic next step per kind of cause. Hints, not claims about the exact fix. */
const KIND_HINT: Partial<Record<Cause['kind'], string>> = {
  'picklist-value': 'Add the missing picklist value to the field (or its value set) in the target, include it in the promotion, or fix the test data.',
  'missing-type': 'Add the missing class or component to a story in this promotion, or deploy it first.',
  'required-field': 'Fill the required field in the test data, or check whether a field became required.',
  'validation-rule': 'Check recent validation rule changes and whether the test data satisfies them.',
  'test-assertion': 'Compare expected and actual values and check whether the logic or the test data changed in this promotion.',
  'unknown-variable': 'The code references something that does not exist in the target. Check that its dependency is in this promotion.',
  'bad-method': 'Check that the class providing the method is promoted together with its caller (same version).',
};

export function causesHeadline(errorCount: number, causes: Cause[]): string {
  const by = new Map<string, number>();
  for (const c of causes) by.set(c.kind, (by.get(c.kind) ?? 0) + 1);
  const parts = [...by].map(([k, n]) => `${n} ${KIND_LABEL[k as Cause['kind']][n > 1 ? 1 : 0]}`);
  return `${errorCount} error${errorCount === 1 ? '' : 's'} from ${causes.length} root cause${causes.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

export function causesExplanation(errorCount: number, causes: Cause[]): string {
  const top = causes.slice(0, 8);
  const fields = top.filter((c) => c.kind === 'missing-field');
  const lines: string[] = [];
  if (fields.length) {
    lines.push('Missing fields (referenced by code, not found in the target org or this promotion):');
    for (const c of fields) lines.push(`• ${c.entity}.${c.field}: ${c.count} error${c.count === 1 ? '' : 's'}`);
  }
  for (const c of top.filter((x) => x.kind !== 'missing-field')) lines.push(`• ${c.label}: ${c.count} error${c.count === 1 ? '' : 's'}`);
  if (causes.length > top.length) lines.push(`• …and ${causes.length - top.length} more`);
  const comps = new Map<string, number>();
  for (const c of causes) for (const x of c.components) comps.set(x, (comps.get(x) ?? 0) + 0);
  const hints = [...new Set(top.map((c) => KIND_HINT[c.kind]).filter((h): h is string => !!h))].slice(0, 3);
  if (fields.length) {
    lines.push('Next step: add the missing field metadata to a user story in this promotion (or deploy it first), then re-validate. Fixing the fields should clear most of the other errors.');
  }
  for (const h of hints) lines.push(`Next step: ${h}`);
  if (!fields.length && !hints.length) lines.push('Next step: fix the listed causes (the first one usually explains many of the others), then re-validate.');
  return lines.join('\n');
}
