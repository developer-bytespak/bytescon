# As-built specs

The original design documents (`PROMPT.md`, `FIXES.md`, `docs/WHO_WINS_MODEL.md`,
`.ai/WINNERS_INTEL_SPEC.md`, `SUBCONTRACTING_WORKFLOW_SPEC.md`) were never committed and their author has
left. These specs were **reconstructed from the code on 2026-11-03**. They describe what the system does and
the reasons the code itself records — not plans that never reached the code. Anything not confirmable from code
is marked **(inferred)**. If a spec and the code disagree, the code wins; fix the spec in the same change.

| Spec | Covers | Read before changing |
|------|--------|----------------------|
| [scoring-and-win-probability.md](scoring-and-win-probability.md) | Eligibility gate, fit/market scores, bid decision, 9-factor probability, calibration, Who Wins model, backtesting, portfolio value | `backend/src/engines/`, `services/scoring/`, `services/whoWins/`, `winProbability.ts`, `decisionEngine.ts` |
| [agent-runtime-and-policies.md](agent-runtime-and-policies.md) | Agent run lifecycle, outbox events, budgets, escalations, artifacts, and what each of the 9 agents may and must never do | `backend/src/services/agents/**` |
| [subcontracting-workflow.md](subcontracting-workflow.md) | SCW-1…SCW-6: primes per opportunity, subaward analysis, outreach drafts, notifications | `services/scw/`, `routes/scw.ts`, `routes/subcontracting*.ts` |
| [winners-intel.md](winners-intel.md) | USAspending award pull, distillation, slice files, proposal-prompt resolver | `services/winnersIntel/` |
| [build-plan-and-fix-log.md](build-plan-and-fix-log.md) | Decoder for the labels in code comments: §4–§8, GB-101…107, FIX-1…6, SCW, Phase N | — |

Each spec ends with **known gaps** found while reconstructing it; the important ones are also tracked in
[../10-status-done-and-remaining.md](../10-status-done-and-remaining.md).
