---
'@mmbridge/cli': minor
---

`mmbridge aps merge <card> --pr <n> [--repo owner/name] [--done]` records a GitHub-merged PR, squash merges included.

- `gh pr view --json state,mergedAt,headRefOid,mergeCommit,baseRefName,url` must be MERGED (APS-H12) with `headRefOid` exactly the reported sha (APS-H11, replaces the H03 ancestor check a squash commit cannot pass), and the merge commit must be on `origin/<base>` after `git fetch` (APS-H13).
- Inserts `merges(sha=<reported>, merged_sha=<merge commit>, applied_ref='merge:<n>@<head>')`; reruns reuse the row (exit 0, no insert).
- `--done` moves merge_wait→done in the same command; a refused done guard (e.g. APS-D05 owner OK) leaves merge_wait and prints `done blocked: …`.
