# Branching & PR strategy

A lightweight trunk-based flow tuned for a two-person team.

## Branches

- `main` — always deployable. Protected: no direct pushes, PR + green CI
  required to merge. Every merge to `main` auto-deploys to the **dev** stack.
- Feature branches — short-lived, branched off `main`. Naming:
  `<initials>/<phase>-<short-desc>`, e.g. `rv/phase1-connect-handler`.

## Flow

1. Branch off `main`.
2. Open a PR early (draft is fine). CI runs lint + typecheck + tests + synth.
3. The other engineer reviews. Anything touching `packages/shared` (the A<->B
   contract) needs both of us to look — that's the interface we both build
   against, so we decide it together before implementing.
4. Squash-merge to `main`. CI deploys dev automatically.

## Ownership

Per the roadmap, Engineer A owns realtime + infra, Engineer B owns app + RAG.
Ownership is about who drives, not a wall — but avoid two people editing the
same Lambda in the same window. Pair on contracts, split on implementation.

## Releases

Phase 0–4 deploy only to `dev`. A `prod` stack and a promotion step land in
Phase 4/5 hardening; until then, `dev` is the only environment.
