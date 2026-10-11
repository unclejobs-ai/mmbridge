import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const VALID_SEVERITIES = new Set(['CRITICAL', 'WARNING', 'INFO', 'REFACTOR']);
const VALID_PARSE_STATES = new Set(['structured', 'semi-structured', 'raw']);
const VALID_KINDS = new Set(['parser', 'bridge']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFinding(finding, context) {
  if (!isObject(finding)) {
    throw new Error(`${context}: finding must be an object`);
  }

  if (typeof finding.severity !== 'string' || !VALID_SEVERITIES.has(finding.severity)) {
    throw new Error(`${context}: invalid severity "${finding.severity}"`);
  }

  if (typeof finding.file !== 'string') {
    throw new Error(`${context}: file must be a string`);
  }

  if (typeof finding.message !== 'string' || finding.message.trim() === '') {
    throw new Error(`${context}: message must be a non-empty string`);
  }

  let line = null;
  if (finding.line == null || finding.line === '') {
    line = null;
  } else if (Number.isInteger(finding.line) && finding.line >= 0) {
    line = finding.line;
  } else {
    throw new Error(`${context}: line must be a non-negative integer or null`);
  }

  return {
    severity: finding.severity,
    file: finding.file,
    line,
    message: finding.message,
  };
}

function validateFixtureShape(rawFixture, filePath) {
  if (!isObject(rawFixture)) {
    throw new Error(`${filePath}: fixture must be an object`);
  }
  if (typeof rawFixture.id !== 'string' || rawFixture.id.trim() === '') {
    throw new Error(`${filePath}: fixture id must be a non-empty string`);
  }
  if (typeof rawFixture.kind !== 'string' || !VALID_KINDS.has(rawFixture.kind)) {
    throw new Error(`${filePath}: fixture kind must be one of parser|bridge`);
  }
  if (!isObject(rawFixture.input)) {
    throw new Error(`${filePath}: fixture input must be an object`);
  }
  if (!isObject(rawFixture.expected)) {
    throw new Error(`${filePath}: fixture expected must be an object`);
  }
}

function validateParserFixture(rawFixture, filePath) {
  if (typeof rawFixture.input.rawText !== 'string') {
    throw new Error(`${filePath}: parser fixture input.rawText must be a string`);
  }
  if (!Array.isArray(rawFixture.expected.findings)) {
    throw new Error(`${filePath}: parser fixture expected.findings must be an array`);
  }
  if (
    rawFixture.expected.parseState !== undefined &&
    (typeof rawFixture.expected.parseState !== 'string' || !VALID_PARSE_STATES.has(rawFixture.expected.parseState))
  ) {
    throw new Error(`${filePath}: parser fixture expected.parseState must be structured|semi-structured|raw`);
  }
}

function validateBridgeFixture(rawFixture, filePath) {
  if (!Array.isArray(rawFixture.input.results)) {
    throw new Error(`${filePath}: bridge fixture input.results must be an array`);
  }
  for (const [index, result] of rawFixture.input.results.entries()) {
    if (!isObject(result)) {
      throw new Error(`${filePath}: bridge input.results[${index}] must be an object`);
    }
    if (typeof result.tool !== 'string' || result.tool.trim() === '') {
      throw new Error(`${filePath}: bridge input.results[${index}].tool must be a non-empty string`);
    }
  }
  if (!Array.isArray(rawFixture.expected.findings)) {
    throw new Error(`${filePath}: bridge fixture expected.findings must be an array`);
  }
}

function normalizeFixture(rawFixture, filePath) {
  validateFixtureShape(rawFixture, filePath);

  if (rawFixture.kind === 'parser') validateParserFixture(rawFixture, filePath);
  if (rawFixture.kind === 'bridge') validateBridgeFixture(rawFixture, filePath);

  const normalizedExpectedFindings = rawFixture.expected.findings.map((finding, index) =>
    normalizeFinding(finding, `${filePath} expected.findings[${index}]`),
  );

  return {
    id: rawFixture.id,
    kind: rawFixture.kind,
    description: typeof rawFixture.description === 'string' ? rawFixture.description : '',
    input: rawFixture.input,
    expected: {
      ...rawFixture.expected,
      findings: normalizedExpectedFindings,
    },
    filePath,
  };
}

async function walkJsonFiles(rootDir, entries) {
  const directoryEntries = await readdir(rootDir, { withFileTypes: true });
  directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of directoryEntries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonFiles(fullPath, entries);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      entries.push(fullPath);
    }
  }
}

export async function collectFixtureFiles(rootDir) {
  const files = [];
  await walkJsonFiles(rootDir, files);
  return files;
}

export async function loadFixturesFromDir(rootDir) {
  const files = await collectFixtureFiles(rootDir);
  const fixtures = [];
  const seenIds = new Set();

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8');
    const rawFixture = JSON.parse(content);
    const fixture = normalizeFixture(rawFixture, filePath);

    if (seenIds.has(fixture.id)) {
      throw new Error(`Duplicate fixture id: ${fixture.id}`);
    }
    seenIds.add(fixture.id);
    fixtures.push(fixture);
  }

  return fixtures;
}
