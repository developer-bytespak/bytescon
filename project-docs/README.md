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
| 10 | [10-status-done-and-remaining.md](10-status-done-and-remaining.md) | What is finished, what is not, and known risks | Founders, PMs, developers |
| 11 | [11-glossary.md](11-glossary.md) | What all the strange words mean (NAICS, SAM, 8(a)…) | Everyone |
| 12 | [12-codebase-map.md](12-codebase-map.md) | Where each thing lives in the code | Developers and AI coding tools |
| 13 | [specs/](specs/README.md) | Detailed as-built specs: scoring, agents, subcontracting, Winners Intel, build-plan labels | Developers and AI coding tools |
| 14 | [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md) | Bugs, improvements, what to automate, competitors and feature gaps (with sources) | Founders, product, developers |

**AI coding tools** (Claude Code, Codex, OpenCode, Antigravity, Cursor, etc.): read [AGENTS.md](AGENTS.md) first.

---

## The 30-second summary

- **What:** Federal contracting intelligence platform (multi-tenant SaaS).
- **For whom:** Government-contracting (GovCon) consulting firms that serve many small-business clients. Also usable by a single small contractor.
- **Main promise:** *"Know your odds before you bid."*
- **Built with:** TypeScript everywhere — React website, Node.js/Express server, PostgreSQL database, Redis job queue, Claude AI (OpenAI/DeepSeek optional).
- **Size:** ~215 database tables, ~90 screens, ~60 API modules, ~20 background jobs, 9 AI agents, 4 MCP servers, ~320 test files.
- **Status:** Feature-complete for a beta. Main blockers before real production are file storage (still on local disk), a few missing production settings, and documentation drift. See [10-status-done-and-remaining.md](10-status-done-and-remaining.md).
