## What & why

<!-- One or two sentences. What does this change and why. Link the roadmap
     phase/task if relevant (e.g. "Phase 1: connect handler"). -->

## Contract impact

<!-- Does this touch packages/shared (message schemas, table keys, API
     surface)? If yes, both engineers should review. If no, say "none". -->

- [ ] Touches the `@backrow/shared` contract (needs both reviewers)
- [ ] No contract change

## Checklist

- [ ] Lint, typecheck, and unit tests pass locally (`npm run lint && npm run typecheck && npm test`)
- [ ] `npm run synth` succeeds (infra changes)
- [ ] Docs/README updated if the dev loop or config changed
- [ ] No secrets committed

## Testing notes

<!-- How you verified this. Manual steps, screenshots, or "unit tests only". -->
