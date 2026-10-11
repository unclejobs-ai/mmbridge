// APS §12 v1 wire contract; keep JSON Schema keywords as data, not JS thenables.
const schema: Record<string, unknown> & { $id: string } = JSON.parse(String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "aps-gates.v1.schema.json",
  "title": "APS §12 gate config (.aps/gates.json), version 1",
  "description": "Read by \u0060mmbridge aps gate\u0060. Semantics are normative in ~/ss-work/rules/AGENT-PRODUCTION-SYSTEM.md §12.3-§12.5. Validate .aps/baseline.json against #/$defs/baselineFile and .aps/exemptions.json against #/$defs/exemptionsFile.",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "repo", "gates"],
  "properties": {
    "$schema": { "type": "string" },
    "version": { "const": 1 },
    "repo": { "type": "string", "pattern": "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", "description": "GitHub owner/name, e.g. unclejobs-ai/christmas-ai-studio." },
    "baselineFile": { "$ref": "#/$defs/repoPath", "default": ".aps/baseline.json" },
    "exemptionsFile": { "$ref": "#/$defs/repoPath", "default": ".aps/exemptions.json" },
    "gates": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/gate" },
      "description": "Gate ids must be unique (checked by the runner; JSON Schema cannot express it)."
    }
  },
  "$defs": {
    "repoPath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!/)(?!.*(^|/)\\.\\.(/|$))[^\\\\]+$",
      "description": "Repo-relative POSIX path; no leading slash, no '..' segment, no backslash."
    },
    "glob": { "type": "string", "minLength": 1, "pattern": "^(?!/)[^\\\\]+$" },
    "gateId": {
      "type": "string",
      "pattern": "^(tests|mutation|static|arch|contract|security|change|metrics|review)\\.[a-z0-9]+(-[a-z0-9]+)*$",
      "description": "<family>.<name>; the family is fixed by §12 item: tests=1 mutation=2 static=3 arch=4 contract=5 security=6 change=7 metrics=8 review=9."
    },
    "metricId": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "gate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "item", "title", "mode", "run"],
      "properties": {
        "id": { "$ref": "#/$defs/gateId" },
        "item": { "type": "integer", "minimum": 1, "maximum": 9, "description": "§12 gate item number; must match the id family." },
        "title": { "type": "string", "minLength": 1 },
        "mode": {
          "enum": ["required", "threshold", "ratchet", "report"],
          "description": "required: pass iff exit code is in okExitCodes (any other exit code is status=fail, waivable). threshold: every metric within min/max. ratchet: every metric no worse than the effective baseline (± tolerance) and within min/max. report: measure only, never blocks. Effective baseline: with --base-ref the value in the base-ref baseline file (key absent there = head seed that must equal current ± tolerance); without --base-ref (local advisory mode) the HEAD worktree baseline file is the trusted comparator."
        },
        "enforcement": { "enum": ["block", "warn"], "default": "block", "description": "warn: failures are reported but do not change the exit code. Ignored for mode=report (always non-blocking)." },
        "when": {
          "type": "object",
          "additionalProperties": false,
          "required": ["changedPaths"],
          "properties": {
            "changedPaths": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/glob" }, "description": "Run only when \u0060git diff --name-only <merge-base(baseRef,HEAD)>..HEAD\u0060 matches one of these globs; otherwise status=skipped. Without --base-ref the gate always runs." }
          }
        },
        "run": {
          "type": "object",
          "additionalProperties": false,
          "required": ["argv"],
          "properties": {
            "argv": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 }, "description": "Executed without a shell. Pipelines belong in a repo script." },
            "cwd": { "$ref": "#/$defs/repoPath", "default": "." },
            "timeoutSec": { "type": "integer", "minimum": 1, "maximum": 3600, "default": 900 },
            "okExitCodes": { "type": "array", "minItems": 1, "items": { "type": "integer", "minimum": 0, "maximum": 255 }, "default": [0], "description": "Exit codes that mean the tool ran. mode=required: any other code is status=fail. Other modes: any other code is status=error. Timeout, spawn failure or metric-extraction failure is always status=error (fail-closed, never waivable)." },
            "env": { "type": "object", "additionalProperties": { "type": "string" }, "propertyNames": { "pattern": "^[A-Z_][A-Z0-9_]*$" }, "description": "Literal, non-secret values only. Secrets come from the CI environment, never from this file." }
          }
        },
        "metrics": { "type": "array", "items": { "$ref": "#/$defs/metric" } },
        "owner": { "type": "string", "description": "Lane or role that maintains this gate (e.g. 'L1-CI')." },
        "doc": { "type": "string", "description": "Pointer to the §12 clause or ADR that defines the gate." }
      },
      "allOf": [
        { "if": { "properties": { "mode": { "enum": ["threshold", "ratchet"] } } }, "then": { "required": ["metrics"], "properties": { "metrics": { "minItems": 1 } } } }
      ]
    },
    "metric": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "source", "direction"],
      "properties": {
        "id": { "$ref": "#/$defs/metricId" },
        "source": { "$ref": "#/$defs/source" },
        "direction": { "enum": ["lower", "higher"], "description": "Which way is better. lower: counts, ratios of bad things. higher: scores, coverage." },
        "unit": { "enum": ["count", "percent", "ratio", "lines", "ms", "score", "days", "hours"], "default": "count" },
        "min": { "type": "number", "description": "Hard floor, enforced in threshold and ratchet modes." },
        "max": { "type": "number", "description": "Hard ceiling, enforced in threshold and ratchet modes." },
        "tolerance": { "type": "number", "minimum": 0, "default": 0, "description": "Ratchet noise allowance in metric units (e.g. 0.5 for a mutation score)." },
        "target": { "type": "number", "description": "Goal value; reported as a gap, never enforced." }
      }
    },
    "source": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["kind", "pointer"],
          "properties": {
            "kind": { "const": "json" },
            "file": { "$ref": "#/$defs/repoPath", "description": "Relative to run.cwd. Omitted = stdout." },
            "pointer": { "type": "string", "pattern": "^(/([^~/]|~[01])*)*$", "description": "RFC 6901 JSON Pointer to a finite number, or to an array (value = its length)." }
          }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["kind", "pattern"],
          "properties": {
            "kind": { "const": "regex" },
            "file": { "$ref": "#/$defs/repoPath" },
            "pattern": { "type": "string", "minLength": 1, "description": "JavaScript RegExp source; first match wins; the capture group must parse as a finite number." },
            "flags": { "type": "string", "pattern": "^[imsu]*$" },
            "group": { "type": "integer", "minimum": 1, "default": 1 }
          }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["kind"],
          "properties": {
            "kind": { "const": "count-lines" },
            "file": { "$ref": "#/$defs/repoPath" },
            "pattern": { "type": "string", "description": "Count only non-empty lines matching this RegExp; omitted = all non-empty lines." }
          }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["kind"],
          "properties": { "kind": { "const": "exit-code" } }
        }
      ]
    },
    "baselineFile": {
      "type": "object",
      "additionalProperties": false,
      "required": ["version", "gates"],
      "properties": {
        "version": { "const": 1 },
        "gates": {
          "type": "object",
          "propertyNames": { "$ref": "#/$defs/gateId" },
          "additionalProperties": {
            "type": "object",
            "propertyNames": { "$ref": "#/$defs/metricId" },
            "additionalProperties": {
              "type": "object",
              "additionalProperties": false,
              "required": ["value", "sha", "measuredAt"],
              "properties": {
                "value": { "type": "number" },
                "sha": { "type": "string", "pattern": "^[0-9a-f]{40}$", "description": "Commit the value was measured on." },
                "measuredAt": { "type": "string", "format": "date-time" }
              }
            }
          }
        }
      }
    },
    "exemptionsFile": {
      "type": "object",
      "additionalProperties": false,
      "required": ["version", "exemptions"],
      "properties": {
        "version": { "const": 1 },
        "exemptions": { "type": "array", "items": { "$ref": "#/$defs/exemption" } }
      }
    },
    "exemption": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "gate", "effect", "reason", "approvedBy", "approvalRef", "createdAt", "expiresAt"],
      "properties": {
        "id": { "type": "string", "pattern": "^EX-[0-9]{8}-[0-9]{2}$" },
        "gate": { "$ref": "#/$defs/gateId" },
        "metric": { "$ref": "#/$defs/metricId", "description": "Omitted = the whole gate." },
        "effect": { "enum": ["waive", "allow"], "description": "waive: comparator failures (status=fail/no-baseline/seed-mismatch) become status=exempt; execution or extraction errors stay status=error. allow: the metric's only comparator becomes \u0060allow\u0060 ± tolerance in the metric's direction, replacing baseline/min/max (baselineSource=exemption)." },
        "allow": { "type": "number" },
        "paths": { "type": "array", "items": { "$ref": "#/$defs/glob" }, "description": "Informational scope for tools that accept path filters; the runner does not filter by it." },
        "reason": { "type": "string", "minLength": 10 },
        "approvedBy": { "const": "owner", "description": "Only the owner (대표님) approves exemptions." },
        "approvalRef": { "type": "string", "minLength": 3, "description": "Owner order id (IN-YYYYMMDD-…), INBOX line or PR comment URL holding the approval." },
        "card": { "type": "string", "description": "Card that needs the exemption." },
        "createdAt": { "type": "string", "format": "date" },
        "expiresAt": { "type": "string", "format": "date", "description": "At most 30 days after createdAt (runner-checked). Expired entries are ignored with a warning." }
      },
      "allOf": [
        { "if": { "properties": { "effect": { "const": "allow" } } }, "then": { "required": ["metric", "allow"] } }
      ]
    },
    "gateResult": {
      "description": "\u0060mmbridge aps gate --format json\u0060 stdout and the --card ledger detail. schema = aps-gate-result/1.",
      "type": "object",
      "required": ["schema", "repo", "headSha", "configSha256", "verdict", "gates"],
      "properties": {
        "schema": { "const": "aps-gate-result/1" },
        "runId": { "type": "string", "format": "uuid" },
        "repo": { "type": "string" },
        "headSha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "baseRef": { "type": ["string", "null"], "description": "null = local advisory mode: HEAD baseline and HEAD exemptions are trusted and a warning is emitted. Card acceptance evidence requires a non-null baseRef." },
        "baseSha": { "type": ["string", "null"], "pattern": "^[0-9a-f]{40}$" },
        "configSha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "baselineSha256": { "type": ["string", "null"], "pattern": "^[0-9a-f]{64}$" },
        "startedAt": { "type": "string", "format": "date-time" },
        "finishedAt": { "type": "string", "format": "date-time" },
        "verdict": { "enum": ["pass", "fail", "error"] },
        "gates": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "item", "mode", "enforcement", "status"],
            "properties": {
              "id": { "$ref": "#/$defs/gateId" },
              "item": { "type": "integer" },
              "mode": { "type": "string" },
              "enforcement": { "type": "string" },
              "status": { "enum": ["pass", "fail", "error", "skipped", "exempt"] },
              "exitCode": { "type": ["integer", "null"] },
              "durationMs": { "type": "integer" },
              "exemption": { "type": ["string", "null"] },
              "message": { "type": "string" },
              "metrics": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["id", "value", "status"],
                  "properties": {
                    "id": { "type": "string" },
                    "value": { "type": ["number", "null"] },
                    "baseline": { "type": ["number", "null"] },
                    "baselineSource": { "enum": ["base", "head-seed", "head", "exemption", null], "description": "base: base-ref file. head-seed: key absent in base-ref, head value used as seed. head: local advisory mode (no --base-ref). exemption: allow exemption." },
                    "limit": { "type": ["number", "null"] },
                    "delta": { "type": ["number", "null"] },
                    "improved": { "type": "boolean" },
                    "status": { "enum": ["pass", "fail", "error", "no-baseline", "seed-mismatch", "exempt"] }
                  }
                }
              }
            }
          }
        },
        "warnings": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}`);
export default schema;
