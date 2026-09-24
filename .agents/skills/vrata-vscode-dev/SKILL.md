---
name: vrata-vscode-dev
description: Develop or deliver Vrata VS Code changes. Use for implementation, repository plans, code review, and PR/CI delivery; choose the route by task scope.
compatibility: Requires git, Node.js 22, npm and GitHub access for PR delivery. Host tests require VS Code and the platform prerequisites in README.md.
---

# Vrata VS Code development

Follow root `AGENTS.md`. This skill owns the full delivery workflow; prompts and
other agent files should link here rather than copy it. It is the project policy
layer; the actual general-purpose workflow skills are vendored beside it.

## Choose the route

- Read-only questions and audits: inspect relevant files and return findings.
- Small changes without behavioral impact (docs, wording, mechanical edits):
  use the task-owned worktree, edit directly, inspect the diff and run the
  applicable checks. No formal plan, plan review, or separate simplification
  workflow is required.
- Bounded executable changes with a clear approach: keep a short working plan,
  implement, simplify the changed code and review it. Use a document plan and
  plan review for significant design decisions, cross-cutting work, or changes
  to credentials, persisted state, cancellation, or extension API contracts.

These routes also govern nested skills. Load only the package needed at the
current stage, using the exact repository-local path. Read references before
first use; reuse unchanged references that remain in context.

## Full workflow for substantial changes

1. Plan with `../ce-plan/SKILL.md` in caller/pipeline mode; its document review is
   `../ce-doc-review/SKILL.md` and reviewer prompts live under
   `../compound-engineering/references/agents/`.
2. Use `../hardening-menu/SKILL.md` in `plan` stage only for optional
   mitigations under consideration; defer them unless already selected.
3. Implement the cleaned plan with `../ce-work/SKILL.md` through its documented
   Phase 2 boundary, then return before Phase 3–4 loads
   `references/shipping-workflow.md`.
4. Run the full simplification pass from `../ce-simplify-code/SKILL.md` while
   preserving this repository's Ponytail rules.
5. Run report-only review from `../ce-code-review/SKILL.md` in `mode:agent`;
   use the vendored `../compound-engineering/` persona prompts when delegation
   is available. With no worker capacity, perform the read-only review locally,
   disclose that it is not independent, and do not wait for unavailable slots.
6. Route review findings through `../hardening-menu/SKILL.md` in `review` stage.
7. Deliver with `../github-pr-workflow/SKILL.md` and wait for CI on the exact
   remote head SHA.

If the client has no native skill loader, read these files directly. Map tool
names through `.agents/README.md`; lack of a vendor-specific primitive does not
permit skipping required verification or a real user decision.

## 1. Establish the working tree

1. Reuse a suitable task-owned branch/worktree when already established.
2. For new work, fetch `origin` and start from current `origin/main`.
3. Create a meaningful branch in an isolated worktree only when needed.
4. Inspect status, current files, callers and tests before planning.

If existing work already satisfies the request, verify it instead of rebuilding
it.

## 2. Plan core before editing

For the substantial route, write or update a plan in the `vrata-docs` repository,
following its `AGENTS.md`, with stable R/U/AE IDs, source paths, verification and
scope boundaries. Pass the plan path explicitly to nested skills; their default
`docs/plans/` location does not override this rule. Save reports and durable
findings there too. Temporary local drafts may stay outside either repository.
For bounded changes, the working plan may stay in the conversation.

Core may include only:

- behavior explicitly requested by the user;
- existing public or persisted contracts;
- behavior required for the normal supported path to work;
- a reproduced regression named by the task or caused by the requested change;
- preservation of the repository invariants in the affected path;
- code required to compile, start or preserve the current contract.

Do not edit code, tests or TODOs for optional defensive behavior before the
hardening decision.

## 3. Plan-stage hardening gate

Inspect only the affected path: callers, producers, trust boundaries, persisted
state, external dependencies, normal failures and existing guarantees.

Treat every non-core validation, guard, catch, retry, timeout, fallback,
normalization, sanitization, compatibility path, recovery mechanism, diagnostic
branch or defensive test as a hardening candidate.

Only when a candidate requires a user decision, provide:

- stable H-ID and category;
- exact scenario and trigger mode;
- trigger practicality and required access/resources;
- concrete impact, scope, persistence, detection and recovery;
- at most two mitigation shapes;
- production/test LOC, files, branches and surface changes;
- implementation risk, recommendation and reconsideration trigger.

Defer unselected optional candidates and continue core work. Briefly report
material deferred candidates in the result. Ask only when the choice blocks
core work or changes an agreed contract; an explicit request for a hardening
menu also warrants presenting it. Existing selections remain authorized.
Never interpret severity or a recommendation as permission.

After the decision, authoritative plan units, acceptance criteria, mandatory
tests and mitigations contain only core plus selected H-IDs. Unselected items
may remain only under `Unselected Hardening Candidates`.

Ask again only if implementation changes the selected behavior, an agreed cost
limit, or an unapproved API/config/schema/state/dependency. Routine variation
in estimated LOC, files or branches is not a new authorization boundary.

## 4. Implement with Ponytail full

Trace the real flow and all callers first. Then stop at the first rung that
works:

1. do not build it;
2. reuse existing code or docs;
3. use the standard library;
4. use a native platform feature;
5. use an installed dependency;
6. use one line;
7. write the minimum new code.

Fix root causes at the shared seam. Do not add speculative abstractions,
interfaces with one implementation, future config, generic frameworks,
fallbacks or compatibility shims. Preserve trust-boundary validation, SecretStorage boundaries, session
cancellation, serialized storage mutations, exact-key redaction, accessibility
and compatibility with the minimum supported VS Code API.

Non-trivial executable logic leaves one smallest runnable check. Pure docs do
not need tests.

## 5. Verify the implementation stage

Run targeted checks while working. Before returning from implementation run the
relevant executable checks and inspect the complete diff. In the repository
pipeline, stop after ce-work Phase 2; do not load its Phase 3–4 shipping workflow,
open a PR, or start review from the implementation stage.

## 6. Ponytail diff pass

Compare the complete diff with `origin/main` and remove:

- speculative abstractions and generic scaffolding;
- duplicated workflow text or source-of-truth facts;
- wrappers around stdlib/platform behavior;
- unused options, branches and future-proofing;
- tests of static config, docs, labels or committed string presence.

Prefer deletion and one canonical owner. Do not remove required validation or
credential safety and cancellation proof.

## 7. Read-only code review

Review the diff separately from implementation. Produce evidence-backed
findings with severity, file/location, concrete consequence and reproduction or
reasoning. Do not edit anything during review.

Review at least:

- requirement and plan fit;
- correctness and real caller flow;
- credentials, privacy and account boundaries where touched;
- cancellation, serialized storage mutations and late replies where touched;
- extension activation, packaging and VS Code compatibility where touched;
- duplication, dead code and simpler native alternatives.

## 8. Review-stage hardening gate

Preserve reviewer evidence and severity, but ignore any auto-fix preference.

- A finding already required by core or a selected H-ID may be fixed.
- Fix regressions caused by this change and violations of required invariants
  as core work without asking again.
- Other findings are optional candidates: defer and report material ones.
- Highlight P0/P1 and ask when a finding blocks safe completion or requires a
  contract decision. Severity alone does not authorize unrelated changes.
- Apply only core and selected findings; unselected hardening stays out of scope.

## 9. Final diff audit

Map every added validation, guard, catch, retry, timeout, fallback,
normalization, sanitization, compatibility/recovery path and defensive test to
an explicit core requirement or selected H-ID. Remove everything unmapped.

Report:

```text
Core:
- <path>: <requirement>

Approved hardening:
- <H-ID>: <paths>

Unselected hardening implemented:
- none
```

## 10. Final checks and delivery

Use `package.json` and `.github/workflows/ci.yml` as authority. Pure documentation
needs `git diff --check` and relevant reference/link checks. Executable changes
need a runnable check of the affected behavior. Before shipping code or build
configuration, run:

```bash
npm run check
npm run package
git diff --check
```

Use Node.js 22. Run the host compatibility checks described in README.md when
changing activation, the manifest, packaging or SecretStorage. Verify the VSIX
excludes development files and source maps. Do not repeat successful checks
without relevant changes, failures or new evidence; CI still owns its required
checks. Use synthetic credentials and loopback HTTP, never a real API key or
paid generation for routine verification.

For implementation-only or review-only requests, return the verified result
to the caller at that boundary. When delivering a PR:

1. stage only intended files and commit conventionally;
2. push the feature branch and update its existing PR, or open one against
   `main` if none exists;
3. verify the remote head SHA equals local `HEAD`;
4. wait for the exact-head CI run to finish green;
5. report the PR URL and green current SHA; PR preparation is complete.

The user merges. Do not wait for a manual merge unless continued monitoring was
requested. Do not merge or publish to Marketplace without an explicit request.

A green run for an earlier SHA is not completion.
