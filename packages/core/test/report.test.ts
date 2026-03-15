import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deduplicateFindings,
  enrichFindings,
  filterScopeFindings,
  formatFindingsText,
  promoteLowConfidence,
  sortFindings,
} from '../dist/report.js';
import type { Finding } from '../dist/types.js';

const f = (
  overrides: Partial<Finding> & { severity: Finding['severity']; file: string; message: string },
): Finding => ({
  line: null,
  ...overrides,
});

// sortFindings
test('sortFindings: CRITICAL before WARNING before INFO before REFACTOR', () => {
  const findings: Finding[] = [
    f({ severity: 'REFACTOR', file: 'a.ts', message: 'r' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
    f({ severity: 'CRITICAL', file: 'c.ts', message: 'c' }),
    f({ severity: 'WARNING', file: 'd.ts', message: 'w' }),
  ];
  const sorted = sortFindings(findings);
  assert.equal(sorted[0].severity, 'CRITICAL');
  assert.equal(sorted[1].severity, 'WARNING');
  assert.equal(sorted[2].severity, 'INFO');
  assert.equal(sorted[3].severity, 'REFACTOR');
});

test('sortFindings: same severity sorted by file name', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'z.ts', message: 'w' }),
    f({ severity: 'WARNING', file: 'a.ts', message: 'w' }),
    f({ severity: 'WARNING', file: 'm.ts', message: 'w' }),
  ];
  const sorted = sortFindings(findings);
  assert.equal(sorted[0].file, 'a.ts');
  assert.equal(sorted[1].file, 'm.ts');
  assert.equal(sorted[2].file, 'z.ts');
});

test('sortFindings: does not mutate original array', () => {
  const findings: Finding[] = [
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
    f({ severity: 'CRITICAL', file: 'a.ts', message: 'c' }),
  ];
  const original = [...findings];
  sortFindings(findings);
  assert.equal(findings[0].severity, original[0].severity);
});

test('sortFindings: empty array returns empty', () => {
  assert.deepEqual(sortFindings([]), []);
});

// deduplicateFindings
test('deduplicateFindings: removes exact duplicate by severity+file+line+message', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', line: 10, message: 'msg' }),
    f({ severity: 'WARNING', file: 'a.ts', line: 10, message: 'msg' }),
  ];
  const result = deduplicateFindings(findings);
  assert.equal(result.length, 1);
});

test('deduplicateFindings: keeps findings with different severity', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', line: 10, message: 'msg' }),
    f({ severity: 'CRITICAL', file: 'a.ts', line: 10, message: 'msg' }),
  ];
  const result = deduplicateFindings(findings);
  assert.equal(result.length, 2);
});

test('deduplicateFindings: keeps findings with different file', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', message: 'msg' }),
    f({ severity: 'WARNING', file: 'b.ts', message: 'msg' }),
  ];
  const result = deduplicateFindings(findings);
  assert.equal(result.length, 2);
});

test('deduplicateFindings: treats null and undefined line as same key', () => {
  const findings: Finding[] = [
    f({ severity: 'INFO', file: 'a.ts', line: null, message: 'msg' }),
    f({ severity: 'INFO', file: 'a.ts', message: 'msg' }),
  ];
  const result = deduplicateFindings(findings);
  assert.equal(result.length, 1);
});

test('deduplicateFindings: empty array returns empty', () => {
  assert.deepEqual(deduplicateFindings([]), []);
});

// filterScopeFindings
test('filterScopeFindings: returns all findings when changedFiles is empty', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
  ];
  const result = filterScopeFindings(findings, []);
  assert.equal(result.length, 2);
});

test('filterScopeFindings: filters out findings not in changedFiles', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
  ];
  const result = filterScopeFindings(findings, ['a.ts']);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'a.ts');
});

test('filterScopeFindings: keeps global scopeHint findings', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'other.ts', message: 'w', scopeHint: 'global' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
  ];
  const result = filterScopeFindings(findings, ['a.ts']);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'other.ts');
});

test('filterScopeFindings: keeps findings with empty file string', () => {
  const findings: Finding[] = [f({ severity: 'WARNING', file: '', message: 'global warning' })];
  const result = filterScopeFindings(findings, ['a.ts']);
  assert.equal(result.length, 1);
});

// promoteLowConfidence
test('promoteLowConfidence: promotes medium-confidence INFO to WARNING', () => {
  const findings: Finding[] = [f({ severity: 'INFO', file: 'a.ts', message: 'i', confidence: 'medium' })];
  const { findings: promoted, promotedCount } = promoteLowConfidence(findings);
  assert.equal(promoted[0].severity, 'WARNING');
  assert.equal(promotedCount, 1);
});

test('promoteLowConfidence: does not promote high-confidence INFO', () => {
  const findings: Finding[] = [f({ severity: 'INFO', file: 'a.ts', message: 'i', confidence: 'high' })];
  const { findings: promoted, promotedCount } = promoteLowConfidence(findings);
  assert.equal(promoted[0].severity, 'INFO');
  assert.equal(promotedCount, 0);
});

test('promoteLowConfidence: does not promote medium-confidence WARNING', () => {
  const findings: Finding[] = [f({ severity: 'WARNING', file: 'a.ts', message: 'w', confidence: 'medium' })];
  const { findings: promoted, promotedCount } = promoteLowConfidence(findings);
  assert.equal(promoted[0].severity, 'WARNING');
  assert.equal(promotedCount, 0);
});

test('promoteLowConfidence: does not promote medium-confidence CRITICAL', () => {
  const findings: Finding[] = [f({ severity: 'CRITICAL', file: 'a.ts', message: 'c', confidence: 'medium' })];
  const { findings: promoted, promotedCount } = promoteLowConfidence(findings);
  assert.equal(promoted[0].severity, 'CRITICAL');
  assert.equal(promotedCount, 0);
});

test('promoteLowConfidence: counts multiple promotions', () => {
  const findings: Finding[] = [
    f({ severity: 'INFO', file: 'a.ts', message: 'i1', confidence: 'medium' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i2', confidence: 'medium' }),
    f({ severity: 'INFO', file: 'c.ts', message: 'i3', confidence: 'high' }),
  ];
  const { promotedCount } = promoteLowConfidence(findings);
  assert.equal(promotedCount, 2);
});

// enrichFindings
test('enrichFindings: full pipeline dedup -> scope -> promote -> sort', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', line: 1, message: 'dup' }),
    f({ severity: 'WARNING', file: 'a.ts', line: 1, message: 'dup' }), // duplicate
    f({ severity: 'INFO', file: 'b.ts', message: 'not in scope' }),
    f({ severity: 'INFO', file: 'a.ts', message: 'promote', confidence: 'medium' }),
    f({ severity: 'CRITICAL', file: 'z.ts', message: 'crit' }),
  ];
  const result = enrichFindings(findings, ['a.ts', 'z.ts']);
  // b.ts filtered out, dup deduped, a.ts INFO promoted to WARNING
  assert.equal(result.filteredCount, 1);
  assert.equal(result.promotedCount, 1);
  // First finding should be CRITICAL
  assert.equal(result.findings[0].severity, 'CRITICAL');
  // Summary contains finding count
  assert.ok(result.summary.includes('finding'));
});

test('enrichFindings: empty changedFiles returns all findings', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
  ];
  const result = enrichFindings(findings, []);
  assert.equal(result.findings.length, 2);
  assert.equal(result.filteredCount, 0);
});

test('enrichFindings: summary includes CRITICAL count when present', () => {
  const findings: Finding[] = [
    f({ severity: 'CRITICAL', file: 'a.ts', message: 'c' }),
    f({ severity: 'WARNING', file: 'b.ts', message: 'w' }),
  ];
  const result = enrichFindings(findings, []);
  assert.ok(result.summary.includes('CRITICAL'));
  assert.ok(result.summary.includes('WARNING'));
});

test('enrichFindings: summary omits zero counts', () => {
  const findings: Finding[] = [f({ severity: 'INFO', file: 'a.ts', message: 'i' })];
  const result = enrichFindings(findings, []);
  assert.ok(!result.summary.includes('CRITICAL'));
  assert.ok(!result.summary.includes('WARNING'));
});

// formatFindingsText
test('formatFindingsText: returns "No findings." for empty array', () => {
  assert.equal(formatFindingsText([]), 'No findings.');
});

test('formatFindingsText: formats finding with line number', () => {
  const findings: Finding[] = [f({ severity: 'WARNING', file: 'a.ts', line: 42, message: 'bad code' })];
  const result = formatFindingsText(findings);
  assert.ok(result.includes('[WARNING]'));
  assert.ok(result.includes('a.ts:42'));
  assert.ok(result.includes('bad code'));
});

test('formatFindingsText: formats finding without line number', () => {
  const findings: Finding[] = [f({ severity: 'CRITICAL', file: 'b.ts', message: 'security issue' })];
  const result = formatFindingsText(findings);
  assert.ok(result.includes('[CRITICAL]'));
  assert.ok(result.includes('b.ts'));
  assert.ok(!result.includes('b.ts:'));
  assert.ok(result.includes('security issue'));
});

test('formatFindingsText: multiple findings separated by newlines', () => {
  const findings: Finding[] = [
    f({ severity: 'CRITICAL', file: 'a.ts', message: 'c' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i' }),
  ];
  const result = formatFindingsText(findings);
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
});
