#!/usr/bin/env node

import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateFixtures } from './lib/evaluate.mjs';
import { loadFixturesFromDir } from './lib/fixtures.mjs';
import { compareWithBaseline } from './lib/scoring.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = path.join(SCRIPT_DIR, 'fixtures');
const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIR, 'baseline.json');

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function buildBaselineFromEvaluation(evaluation) {
  const fixtureThresholds = {};
  for (const fixture of evaluation.fixtures) {
    fixtureThresholds[fixture.id] = {
      minF1: round3(fixture.score.f1),
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    metrics: {
      overall: {
        minMeanF1: round3(evaluation.overall.meanF1),
        minExactRate: round3(evaluation.overall.exactRate),
      },
      parser: {
        minMeanF1: round3(evaluation.suites.parser.meanF1),
        minExactRate: round3(evaluation.suites.parser.exactRate),
      },
      bridge: {
        minMeanF1: round3(evaluation.suites.bridge.meanF1),
        minExactRate: round3(evaluation.suites.bridge.exactRate),
      },
    },
    fixtures: fixtureThresholds,
  };
}

function printHelp() {
  console.log(`mmbridge quality harness

Usage:
  node benchmarks/mmbridge-quality/run.mjs [options]

Options:
  --fixtures <dir>         Fixture directory (default: benchmarks/mmbridge-quality/fixtures)
  --baseline <file>        Baseline JSON path (default: benchmarks/mmbridge-quality/baseline.json)
  --kind <parser|bridge>   Run only one fixture kind
  --update-baseline        Write baseline from current run
  --json                   Print machine-readable JSON output
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const options = {
    fixturesDir: DEFAULT_FIXTURES_DIR,
    baselinePath: DEFAULT_BASELINE_PATH,
    kind: undefined,
    updateBaseline: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixtures') {
      options.fixturesDir = path.resolve(argv[++i]);
      continue;
    }
    if (arg === '--baseline') {
      options.baselinePath = path.resolve(argv[++i]);
      continue;
    }
    if (arg === '--kind') {
      options.kind = argv[++i];
      continue;
    }
    if (arg === '--update-baseline') {
      options.updateBaseline = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.kind !== undefined && options.kind !== 'parser' && options.kind !== 'bridge') {
    throw new Error(`Invalid --kind value "${options.kind}". Use parser or bridge.`);
  }

  return options;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadCoreApi() {
  const coreDistPath = path.resolve(SCRIPT_DIR, '../../packages/core/dist/index.js');
  const coreModuleUrl = pathToFileURL(coreDistPath).href;
  try {
    const mod = await import(coreModuleUrl);
    return {
      parseFindings: mod.parseFindings,
      detectParseState: mod.detectParseState,
      runBridge: mod.runBridge,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load packages/core dist build at ${coreDistPath}. Run "pnpm -C packages/core build" first.\n${message}`,
    );
  }
}

function printTextReport(evaluation, regressions, baselinePath, baselineCompared) {
  const failedFixtures = evaluation.fixtures.filter((fixture) => !fixture.pass).length;
  console.log('mmbridge quality benchmark');
  console.log(`fixtures=${evaluation.fixtureCount} failed=${failedFixtures}`);
  console.log(
    `overall meanF1=${evaluation.overall.meanF1.toFixed(3)} exactRate=${evaluation.overall.exactRate.toFixed(3)} passRate=${evaluation.overall.passRate.toFixed(3)}`,
  );
  console.log(
    `parser meanF1=${evaluation.suites.parser.meanF1.toFixed(3)} exactRate=${evaluation.suites.parser.exactRate.toFixed(3)} passRate=${evaluation.suites.parser.passRate.toFixed(3)}`,
  );
  console.log(
    `bridge meanF1=${evaluation.suites.bridge.meanF1.toFixed(3)} exactRate=${evaluation.suites.bridge.exactRate.toFixed(3)} passRate=${evaluation.suites.bridge.passRate.toFixed(3)}`,
  );

  for (const fixture of evaluation.fixtures) {
    const status = fixture.pass ? 'PASS' : 'FAIL';
    console.log(`- ${status} ${fixture.id} f1=${fixture.score.f1.toFixed(3)} exact=${fixture.score.exactMatch}`);
  }

  if (baselineCompared) {
    if (regressions.length === 0) {
      console.log(`baseline=${baselinePath} status=PASS`);
    } else {
      console.log(`baseline=${baselinePath} status=FAIL regressions=${regressions.length}`);
      for (const regression of regressions) {
        const actual = typeof regression.actual === 'number' ? regression.actual.toFixed(3) : String(regression.actual);
        console.log(
          `  * ${regression.code} actual=${actual} expected>=${regression.expectedAtLeast.toFixed ? regression.expectedAtLeast.toFixed(3) : regression.expectedAtLeast}`,
        );
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const fixtures = await loadFixturesFromDir(options.fixturesDir);
  const selectedFixtures = options.kind ? fixtures.filter((fixture) => fixture.kind === options.kind) : fixtures;
  if (selectedFixtures.length === 0) {
    throw new Error(`No fixtures found for selection in ${options.fixturesDir}`);
  }

  const coreApi = await loadCoreApi();
  const evaluation = await evaluateFixtures(selectedFixtures, coreApi);

  let regressions = [];
  let baselineCompared = false;
  if (options.updateBaseline) {
    const baseline = buildBaselineFromEvaluation(evaluation);
    await writeFile(options.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  } else if (await fileExists(options.baselinePath)) {
    baselineCompared = true;
    const baseline = JSON.parse(await readFile(options.baselinePath, 'utf8'));
    regressions = compareWithBaseline(evaluation, baseline);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          evaluation,
          regressions,
          baselinePath: options.baselinePath,
          baselineCompared,
          baselineUpdated: options.updateBaseline,
        },
        null,
        2,
      ),
    );
  } else {
    printTextReport(evaluation, regressions, options.baselinePath, baselineCompared);
  }

  if (regressions.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
