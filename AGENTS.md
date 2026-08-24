# AGENTS.md

dom is a TypeScript project built on Ink (React for the terminal).

## Stack
- Language: TypeScript
- Framework: Ink (React for the terminal)
- Modules: ES modules (NodeNext — imports carry explicit .js extensions)
- Notable deps: ink, react, zod, execa

## Commands
- Build: `npm run build`
- Test: `npm run verify`
- Dev: `npm run dev`

## Layout
- `src/` — source code
- `verify/` — test / verification suites

## Conventions
Written in TypeScript; ESM with explicit `.js` import extensions; tests run via a custom Node harness (see the verify script); no formatter config detected — match the surrounding style.
