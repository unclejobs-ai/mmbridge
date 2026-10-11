const EPSILON = 1e-9;

export function findingKey(finding) {
  const line = finding.line == null ? '' : String(finding.line);
  return `${finding.severity}|${finding.file}|${line}|${finding.message}`;
}

function toUniqueSet(findings) {
  const keys = new Set();
  for (const finding of findings) keys.add(findingKey(finding));
  return keys;
}

export function scoreFindingSets(expectedFindings, actualFindings) {
  const expectedSet = toUniqueSet(expectedFindings);
  const actualSet = toUniqueSet(actualFindings);

  let truePositives = 0;
  for (const key of actualSet) {
    if (expectedSet.has(key)) truePositives++;
  }

  const falsePositives = actualSet.size - truePositives;
  const falseNegatives = expectedSet.size - truePositives;

  const precision = actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositives / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositives / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    expectedCount: expectedSet.size,
    actualCount: actualSet.size,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    exactMatch: falsePositives === 0 && falseNegatives === 0,
  };
}

function compareMetric(regressions, scope, metricName, actual, minExpected) {
  if (typeof minExpected !== 'number') return;
  if (typeof actual !== 'number' || Number.isNaN(actual) || actual + EPSILON < minExpected) {
    regressions.push({
      code: `${scope}.${metricName}`,
      scope,
      metric: metricName,
      expectedAtLeast: minExpected,
      actual,
    });
  }
}

export function compareWithBaseline(current, baseline) {
  if (!baseline || typeof baseline !== 'object') return [];

  const regressions = [];
  const baselineMetrics = baseline.metrics ?? {};

  if (baselineMetrics.overall) {
    compareMetric(regressions, 'overall', 'meanF1', current.overall?.meanF1, baselineMetrics.overall.minMeanF1);
    compareMetric(
      regressions,
      'overall',
      'exactRate',
      current.overall?.exactRate,
      baselineMetrics.overall.minExactRate,
    );
  }

  for (const [suiteName, suiteThresholds] of Object.entries(baselineMetrics)) {
    if (suiteName === 'overall') continue;
    const suite = current.suites?.[suiteName];
    compareMetric(regressions, suiteName, 'meanF1', suite?.meanF1, suiteThresholds?.minMeanF1);
    compareMetric(regressions, suiteName, 'exactRate', suite?.exactRate, suiteThresholds?.minExactRate);
  }

  const fixtureMap = new Map((current.fixtures ?? []).map((fixture) => [fixture.id, fixture]));
  for (const [fixtureId, fixtureThreshold] of Object.entries(baseline.fixtures ?? {})) {
    const fixture = fixtureMap.get(fixtureId);
    if (!fixture) {
      regressions.push({
        code: `${fixtureId}.missing`,
        scope: fixtureId,
        metric: 'missing',
        expectedAtLeast: 1,
        actual: 0,
      });
      continue;
    }
    compareMetric(regressions, fixtureId, 'f1', fixture.score?.f1, fixtureThreshold?.minF1);
  }

  return regressions;
}
