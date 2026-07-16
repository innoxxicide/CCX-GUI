# Contributing

This is a personal project. There is no external contribution process — what follows are the working conventions.

## Workflow

Commit directly to `main`. No feature branches, no pull requests, no review gate.

CI runs on every push to any branch (`.github/workflows/`): ai-bridge tests, webview tests with typecheck, and Java tests. Nothing blocks a push, so the suites are only worth having if their results actually get read.

## Language

English is the development language: code, comments, commit messages and documentation. Legacy Chinese comments and docs are migrated to English as they are touched.
