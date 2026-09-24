---
name: vrata-vscode-review
description: Review and simplify changes in vrata-vscode. Use for PR review, pre-push checks, cleanup or refactoring of the extension, tests, skills and development workflows; prioritize credential safety, cancellation and VSIX compatibility.
---

# Review Vrata VS Code

1. Read root `AGENTS.md`. Resolve the requested PR/base and inspect its complete
   diff, including committed changes. Read changed files and their callers/tests.
   Include local changes only when they belong to the requested scope.
2. Check concrete failure paths:
   - Replacement/removal/reload overlap; storage fails; validation returns late;
     disposal occurs during an awaited operation; no old-account result survives.
   - A command/provider/storage error carries a current, candidate or old request
     key; original diagnostics remain useful but all known keys are redacted.
   - Discovery runs silently, shares pending catalog loads and retries only after
     failure; cancellation does not trigger another paid request.
   - SSE fragments split UTF-8 or tool JSON; malformed/truncated batches execute
     no tools; stream readers and editor subscriptions are released.
   - Manifest/types agree on minimum VS Code API; development assets stay outside
     the VSIX; CI runs on PRs and never depends on production credentials.
3. Review reuse, readability and resource use separately. Prefer existing helpers,
   remove verified dead code and avoid duplicate work. Preserve output, exception
   identity, side effects and ordering. Never remove a safety check as cleanup.
4. In report-only reviews, leave files untouched. When cleanup/fixes are requested,
   apply only evidenced improvements and run focused regressions, then
   `npm run check` and `npm run package`. Keep formatting separate from semantic
   changes when inspecting the diff. Follow the dev skill for host checks.
5. Return findings ordered by severity with file/line, trigger, consequence and a
   concrete fix. State when no findings remain. Distinguish observed failures from
   risks, and list checks actually run. Do not call a self-review independent;
   use a separate reviewer when the environment supports one and disclose limits.
6. Update the existing PR only when requested. Store durable review reports in
   `vrata-docs` under its publishing rules.
