# Contributing to muse-takeone

Thanks for looking. muse-takeone is a focused fork: the Muse reconstruction
workflow is the product; the upstream takeone scenario engine underneath is
maintained conservatively.

## Ground rules

- **Don't rewrite stable upstream code.** The scenario recorder, runner, and
  compositor core came from [takeone](https://github.com/atharvadeosthale/takeone)
  and work. Fix real bugs; don't restyle.
- **Attribute honestly.** New files you add are yours; don't present upstream
  code as your own, and keep the original MIT copyright attribution intact.
- **Reconstruction quality is the bar.** A change that makes the camera
  jumpier, the timing less believable, or the output non-deterministic is a
  regression, even if the code is cleaner.

## Development

```bash
npm ci
npm run build
npm test          # unit tests, must pass
npm run typecheck # must pass
npm run visual-qa # renders fixtures, diffs vs baselines (needs Chromium)
```

- `node tests/fixtures/visual/gen.mjs` regenerates the visual fixtures.
- `npm run visual-qa:update` re-baselines after an intentional rendering change
  — review the contact-sheet diffs by eye before committing them.

## Pull requests

1. One logical change per PR; keep diffs reviewable.
2. Add or update unit tests for behavior changes (`tests/*.test.ts`, cases are
   lettered — continue the sequence).
3. If the change affects rendering, run `npm run visual-qa` and say what it
   showed in the PR body.
4. Update `CHANGELOG.md` under Unreleased.
5. The PR body should say what you ran: `npm test`, `npm run typecheck`,
   `npm run build`, and their results.

## Commit style

Logical commits with a scope prefix, e.g. `reconstruct: …`, `compositor: …`,
`docs: …`, `tests: …`. Present tense, specific.

## Reporting issues

Include: the input JSON (with fake credentials / redacted frames if
sensitive), `muse-takeone inspect` output, the QA warnings from the render,
and what you expected. For rendering bugs, the contact sheet is usually
enough to diagnose.
