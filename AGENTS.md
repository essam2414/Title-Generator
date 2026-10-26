# Repository Guidelines

## Project Structure & Module Organization

This is a Next.js App Router application. User-facing pages and API routes live in `app/`; reusable UI is in `components/`; domain logic is grouped in `lib/` (generation, retrieval, media, providers, storage, and feedback). Data collection, evaluation, and import commands live in `scripts/`, with shared script helpers and their tests in `scripts/lib/`. App and library unit tests sit beside their modules as `*.test.ts`. Dataset examples and notes are in `datasets/`; runtime data is stored locally under ignored `data/`, and design notes and handoffs are in `docs/`.

## Build, Test, and Development Commands

Run `npm ci` to install the locked dependencies. Use `npm run dev` for the local Next.js development server, `npm run build` to create a production build, and `npm start` to serve that build. Run `npm run typecheck` for strict TypeScript checks and `npm test` for the Vitest suite; `npm run test:watch` keeps tests running during edits. Data and evaluation tasks are exposed as named scripts in `package.json`, such as `npm run eval` and `npm run verify:retrieval`.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and the `@/` alias for imports from the repository root. Follow nearby code style: two-space indentation, single quotes in TypeScript, semicolons, and clear module names in kebab-case. Keep tests adjacent to the code they exercise and name them `<module>.test.ts`. No dedicated formatter or linter command is defined in `package.json`.

## Testing Guidelines

Add or update focused Vitest tests for behavior changes, especially shared logic and data transformations. Run `npm test` and `npm run typecheck` before submitting; run `npm run build` for changes affecting Next.js routes, configuration, or production bundling. Tests use the `*.test.ts` naming pattern; no coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use concise, imperative subjects (for example, “Fix stale vote state…”). Keep commits focused and describe the user-visible change or bug fixed. Pull requests should explain the change and its motivation, list validation commands and results, link related issues when available, and include screenshots for visual changes. Call out database migrations, data changes, and required configuration updates explicitly.

## Security & Configuration

Keep API keys, passcodes, and service credentials in local environment configuration; never commit secrets or real user data. Review scripts that access external providers or datasets before running them, and document any new required environment variables.
