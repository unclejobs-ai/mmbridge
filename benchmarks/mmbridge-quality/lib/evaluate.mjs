import { scoreFindingSets } from './scoring.mjs';

function checkEquality(name, actual, expected) {
  return {
    name,
    expected,
    actual,
    pass: actual === expected,
  };
}

function suiteMetrics(results) {
  if (results.length === 0) {
    return {
      total: 0,
      meanF1: 1,
      exactRate: 1,
      passRate: 1,
    };
  }

  const total = results.length;
  const sumF1 = results.reduce((sum, result) => sum + result.score.f1, 0);
  const exact = results.reduce((sum, result) => sum + (result.score.exactMatch ? 1 : 0), 0);
  const passing = results.reduce((sum, result) => sum + (result.pass ? 1 : 0), 0);

  return {
    total,
    meanF1: sumF1 / total,
    exactRate: exact / total,
    passRate: passing / total,
  };
}

async function evaluateParserFixture(fixture, coreApi) {
  const actualFindings = coreApi.parseFindings(fixture.input.rawText);
  const parseState = coreApi.detectParseState(fixture.input.rawText);
  const score = scoreFindingSets(fixture.expected.findings, actualFindings);

  const checks = [];
  if (fixture.expected.parseState !== undefined) {
    checks.push(checkEquality('parseState', parseState, fixture.expected.parseState));
  }

  const pass = score.exactMatch && checks.every((check) => check.pass);

  return {
    id: fixture.id,
    kind: fixture.kind,
    score,
    pass,
    checks,
    actual: {
      parseState,
      findings: actualFindings,
    },
  };
}

async function evaluateBridgeFixture(fixture, coreApi) {
  const bridgeResult = await coreApi.runBridge(fixture.input);
  const score = scoreFindingSets(fixture.expected.findings, bridgeResult.findings);

  const checks = [];
  if (fixture.expected.consensusFindings !== undefined) {
    checks.push(checkEquality('consensusFindings', bridgeResult.consensusFindings, fixture.expected.consensusFindings));
  }
  if (fixture.expected.profile !== undefined) {
    checks.push(checkEquality('profile', bridgeResult.profile, fixture.expected.profile));
  }
  if (fixture.expected.totalInputs !== undefined) {
    checks.push(checkEquality('totalInputs', bridgeResult.totalInputs, fixture.expected.totalInputs));
  }
  if (fixture.expected.counts !== undefined) {
    for (const [severity, count] of Object.entries(fixture.expected.counts)) {
      checks.push(checkEquality(`counts.${severity}`, bridgeResult.counts[severity] ?? 0, count));
    }
  }

  const pass = score.exactMatch && checks.every((check) => check.pass);

  return {
    id: fixture.id,
    kind: fixture.kind,
    score,
    pass,
    checks,
    actual: {
      profile: bridgeResult.profile,
      totalInputs: bridgeResult.totalInputs,
      consensusFindings: bridgeResult.consensusFindings,
      counts: bridgeResult.counts,
      findings: bridgeResult.findings,
    },
  };
}

export async function evaluateFixtures(fixtures, coreApi) {
  const fixtureResults = [];

  for (const fixture of fixtures) {
    if (fixture.kind === 'parser') {
      fixtureResults.push(await evaluateParserFixture(fixture, coreApi));
      continue;
    }
    if (fixture.kind === 'bridge') {
      fixtureResults.push(await evaluateBridgeFixture(fixture, coreApi));
      continue;
    }
    throw new Error(`Unsupported fixture kind: ${fixture.kind}`);
  }

  const parserResults = fixtureResults.filter((result) => result.kind === 'parser');
  const bridgeResults = fixtureResults.filter((result) => result.kind === 'bridge');

  return {
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtureResults.length,
    suites: {
      parser: suiteMetrics(parserResults),
      bridge: suiteMetrics(bridgeResults),
    },
    overall: suiteMetrics(fixtureResults),
    fixtures: fixtureResults,
  };
}
