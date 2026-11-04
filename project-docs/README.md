# Bytescon — Project Documentation

> **Start here.** This folder explains the whole Bytescon project in plain language.
> It is **documentation only**. Nothing in this folder is imported, built, tested, or deployed.
> Deleting or editing these files can never break the app.

**Snapshot date:** 2026-11-03 (written from the code on the `main` branch at commit `ed3c5eb`).

---

## What is Bytescon? (one paragraph)

The US government buys billions of dollars of things and services from companies every year.
Small companies *can* win those deals, but finding them, deciding which to try for, writing the long
paperwork, and then doing the job correctly is very hard. **Bytescon is a website that helps with
every step** — it finds the deals, guesses the chance of winning, checks the rules, helps write the
proposal, and keeps track of the work and the money after you win. It is built for **consulting firms**
that help many small businesses at once.

---

## How to read this folder

| # | File | Read it if you want to know… | Who it's for |
|---|------|------------------------------|--------------|
| 1 | [01-explain-like-im-5.md](01-explain-like-im-5.md) | The whole idea as a simple story | Everyone, even kids |
| 2 | [02-who-is-it-for.md](02-who-is-it-for.md) | Who uses it and how it helps them | Business, sales, investors |
| 3 | [03-key-features.md](03-key-features.md) | Every big feature, in plain words | Everyone |
| 4 | [04-functional-requirements.md](04-functional-requirements.md) | Exactly what the system must *do* | Product, QA, developers |
| 5 | [05-non-functional-requirements.md](05-non-functional-requirements.md) | How well it must work (safe, fast, reliable) | Tech leads, security, ops |
| 6 | [06-tech-stack.md](06-tech-stack.md) | What tools and languages it's built with | Developers |
| 7 | [07-how-it-works.md](07-how-it-works.md) | How the pieces connect (architecture) | Developers, tech leads |
| 8 | [08-ai-agents.md](08-ai-agents.md) | The 9 AI helpers and what they're allowed to do | Everyone |
| 9 | [09-pricing-and-plans.md](09-pricing-and-plans.md) | What it costs and what each add-on unlocks | Business, sales |
| 10 | [10-status-done-and-remaining.md](10-status-done-and-remaining.md) | What is finished, what is left, and the go-live plan: your decisions and tasks, order, rehearsal, costs | Founders, PMs, developers |
| 11 | [11-glossary.md](11-glossary.md) | What all the strange words mean (NAICS, SAM, 8(a)…) | Everyone |
| 12 | [12-codebase-map.md](12-codebase-map.md) | Where each thing lives in the code | Developers and AI coding tools |
| 13 | [specs/](specs/README.md) | Detailed as-built specs: scoring, agents, subcontracting, Winners Intel, build-plan labels | Developers and AI coding tools |
| 14 | [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md) | Bugs, improvements, what to automate, competitors and feature gaps (with sources) | Founders, product, developers |
| 15 | [15-fix-report-uploaded-files-lost.md](15-fix-report-uploaded-files-lost.md) | Fix report: uploaded files lost on restart — cause, how to reproduce, how to test, how to switch it on | Founders, developers |
| 16 | [16-billing-one-subscription.md](16-billing-one-subscription.md) | Billing fix: base plan + add-ons as one subscription and one charge — findings, plan, tests, status | Founders, developers |
| 17 | [17-subcontracting-leads-per-firm.md](17-subcontracting-leads-per-firm.md) | Fix: subcontracting leads shared between firms — findings, plan, tests, status | Developers |
| 18 | [18-remove-team-members.md](18-remove-team-members.md) | Fix: removing team members, freeing seats, ending sessions — findings, plan, tests, status | Founders, developers |
| 20 | [20-environments-staging-and-production.md](20-environments-staging-and-production.md) | Staging (internal) and production (end users): setup, access locks, release flow, checks | Founders, developers |
| 21 | [21-agents-opt-in.md](21-agents-opt-in.md) | Fix: AI agents truly opt-in (on/off switch, level and AI budget for event-triggered runs) — findings, plan, tests, status | Founders, developers |
| 22 | [22-role-changes-apply-at-once.md](22-role-changes-apply-at-once.md) | Fix: role changes apply at once; granular roles can sign in — findings, plan, tests, status | Founders, developers |
| 23 | [23-backtest-platform-operators-only.md](23-backtest-platform-operators-only.md) | Fix: model test and scoring-curve refresh limited to Bytescon operators — findings, change, tests | Founders, developers |
| 24 | [24-job-alerts-and-backup-noise.md](24-job-alerts-and-backup-noise.md) | Fix: failure alerts and silence watch for every background job; false backup alert removed — findings, change, tests | Founders, developers |
| 25 | [25-customer-facing-rough-edges.md](25-customer-facing-rough-edges.md) | Fix: Feedback wording, SAM.gov key text, broken search link — findings, change, tests | Founders, developers |
| 26 | [26-remaining-bugs-fixed.md](26-remaining-bugs-fixed.md) | Fix: the remaining review bugs (agents, scoring, 8(a), portal, dates), and what's still open | Founders, developers |
| 27 | [27-spec-gap-bugs-fixed.md](27-spec-gap-bugs-fixed.md) | Fix: bugs from the specs' known-gaps lists (agents, scoring, subcontracting, Winners Intel) |

**AI coding tools** (Claude Code, Codex, OpenCode, Antigravity, Cursor, etc.): read [AGENTS.md](AGENTS.md) first.

---

## The 30-second summary

- **What:** Federal contracting intelligence platform (multi-tenant SaaS).
- **For whom:** Government-contracting (GovCon) consulting firms that serve many small-business clients. Also usable by a single small contractor.
- **Main promise:** *"Know your odds before you bid."*
- **Built with:** TypeScript everywhere — React website, Node.js/Express server, PostgreSQL database, Redis job queue, Claude AI (OpenAI/DeepSeek optional).
- **Size:** ~215 database tables, ~90 screens, ~60 API modules, ~20 background jobs, 9 AI agents, 4 MCP servers, ~320 test files.
- **Status:** Feature-complete for a beta. Main blockers before real production are file storage (still on local disk), a few missing production settings, and documentation drift. See [10-status-done-and-remaining.md](10-status-done-and-remaining.md).
