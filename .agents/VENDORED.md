# Vendored development skills

Source: [v-lebedev/ai-billing-gateway](https://github.com/v-lebedev/ai-billing-gateway/tree/12f4fa35997662b1d356d191006ba8787590f037/.agents),
revision `12f4fa35997662b1d356d191006ba8787590f037`, imported 2026-09-24.

Eight complete general-purpose packages were copied from `.agents/skills/`,
including references, schemas, scripts and the Compound Engineering upstream
license. The source package records its upstream provenance in
[its VENDORED.md](https://github.com/v-lebedev/ai-billing-gateway/blob/12f4fa35997662b1d356d191006ba8787590f037/.agents/VENDORED.md).

## Local adaptations

- `vrata-vscode-dev/SKILL.md` is adapted from `aibg-development/SKILL.md`:
  extension commands, credential/cancellation boundaries, host checks,
  documentation repository and existing-PR delivery replace server-specific rules.
- `.agents/README.md` and `PROMPTS.md` are adapted from the same source.
- Root `CLAUDE.md` and `GEMINI.md` retain the source entrypoint content.
- Server operations and `scripts/agent_context.py` are not imported.
- General packages preserve source content and executable modes except trailing
  whitespace and final blank-line normalization in:
  - `skills/compound-engineering/SKILL.md`
  - `skills/compound-engineering/references/agents/ce-code-simplicity-reviewer.md`
  - `skills/compound-engineering/references/agents/ce-design-implementation-reviewer.md`

## Package verification

Digests are SHA-256 over sorted regular files: relative POSIX path, NUL,
octal permission bits, NUL, file bytes, NUL. Source and destination columns
make the whitespace adaptation explicit. Prettier excludes these eight
packages to avoid rewriting upstream resources during ordinary development.

| Package                | Files | Source digest                                                      | Destination digest                                                 |
| ---------------------- | ----: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ce-plan`              |    10 | `a6506743408fd4bf27cad9279f8a2c101d7915a8d3565f83d5a29a9bdd078933` | `a6506743408fd4bf27cad9279f8a2c101d7915a8d3565f83d5a29a9bdd078933` |
| `ce-doc-review`        |    14 | `75a92a338f06945479321bb061dafd4029666289f2794dc01c7a79b0dc841e72` | `75a92a338f06945479321bb061dafd4029666289f2794dc01c7a79b0dc841e72` |
| `hardening-menu`       |     1 | `e3a1bac10fcc37fa6e9bf84df6d3d8b463b720584787b88e98490385f5daf473` | `e3a1bac10fcc37fa6e9bf84df6d3d8b463b720584787b88e98490385f5daf473` |
| `ce-work`              |     5 | `383cb61516b9f79d5ff1d15588f29558b9ae5198cb300c35b6cc35be8c95ec6a` | `383cb61516b9f79d5ff1d15588f29558b9ae5198cb300c35b6cc35be8c95ec6a` |
| `ce-simplify-code`     |     1 | `97a66ae7153d2a078704ee449467d8759af17d660c44de6f82920e291e62a856` | `97a66ae7153d2a078704ee449467d8759af17d660c44de6f82920e291e62a856` |
| `ce-code-review`       |    14 | `e619c84896d6f7affdbf68ae673694c06e221d5fbf7e740e535b8c25d4b0568c` | `e619c84896d6f7affdbf68ae673694c06e221d5fbf7e740e535b8c25d4b0568c` |
| `compound-engineering` |    51 | `e4897309db11229c89f273276444e5f65862b26ac622157e7223c8bf2fa9c09c` | `bbeb7312ce45be2aa43e000ae7e751938eb9fde2401a25b747cd529b0b80a9cb` |
| `github-pr-workflow`   |    13 | `1663c5383db5b400a42e7eb15567a51d0e38b6798054290ea6f1b919241a3c74` | `1663c5383db5b400a42e7eb15567a51d0e38b6798054290ea6f1b919241a3c74` |
