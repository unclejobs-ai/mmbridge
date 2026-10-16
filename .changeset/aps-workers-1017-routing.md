---
'@mmbridge/aps': minor
'@mmbridge/cli': patch
---

APS default worker registry follows the 10/17 routing.

- L3 mech, in order: `glm` (`zai/glm-5.3:high`, `w-glm`), `cursor-grok` (`cursor/grok-4.7-500k-fast:high`, `w-cursor-grok`), `glmflash` (`zai/glm-5.3-flash:high`, `w-glmflash`). These are the only auto-dispatched mech workers.
- L2 has no mech role: review = `sol`, `astra` (GPT Codex); design = `opus-high` (`anthropic/claude-opus-5-5:high`); vision = `opus-xhigh` (`anthropic/claude-opus-5-5:xhigh`).
- Removed: `devin-swe2`, `gemini-flash`, `deepseek-flash`, `grok` (xai-oauth), `kimi`, `qwen`, `opus-fusion` (Devin Fusion first rule), `opus-med`, `qa-vision`, `astra-vision`.
- Audit counts the `muse` trial models as L3; Fable stays premium so a stray Fable lane is still flagged.
