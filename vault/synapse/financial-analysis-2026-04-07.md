# Financial Analysis: Synapse Enrichment Cost & Unit Economics
**Date:** 2026-04-07  
**Task:** 2537eb84-073c-4524-9ac3-0a18756d1cb5 (re-run after null delivery)  
**Evidence:** knowledge/projects/synapse/review-context.json, vault/synapse/strategic-review-2026-04-07.md  

---

## 1. Enrichment Cost Tracking — What Was Spent, What Remains

### Spent to Date: ~USD $1,039

No per-run invoice breakdown is available in the codebase, but the total is confirmed in review-context.json (`costToDate: ~$1,039 in enrichment API costs`). Work delivered for that spend:

| Item | Rows | Status |
|------|------|--------|
| ANZCA LOs (Opus, avg 39K chars) | 330/330 | ✅ Done |
| ANZCA MCQs | 1,427/1,427 | ✅ Done |
| ANZCA SAQs (enriched body) | 551/551 | ✅ Done (citations missing) |
| CICM LOs (partial — reset after data clean) | 76/247 | ⚠️ Partially done |
| CICM MCQs | 264 | ✅ Done |
| CICM SAQs | 558/657 (85%) | ✅ Mostly done |
| ACEM MCQs (partial) | 1,161/1,543 (75%) | ⚠️ In progress |
| Document chunk embeddings | ~333,804 rows | ✅ Done |

**Cost efficiency:** $1,039 / 333,804 chunk rows = **$0.0031/chunk** for embeddings. For enriched LOs at Opus: ~$293 / 330 = **$0.89/LO** — this is the highest-value enrichment (39K char ground truth recall).

---

### Remaining Work: USD $815–1,005

Phased by launch sequence:

| Phase | Items | Est. Cost | Priority |
|-------|-------|-----------|----------|
| **Phase 1 — ANZCA Launch** | SAQ citations (458 questions, Sonnet) | ~$85 | **NOW** |
| **Phase 1 — ANZCA Launch** | VIVA model_answer (1,764 questions, Sonnet) | ~$380 | **NOW** |
| **Phase 1 subtotal** | | **~$465** | |
| Phase 2 — CICM Alpha | LOs (171 remaining, Opus) | ~$80–120 | Post-launch |
| Phase 2 — CICM Alpha | SAQs (99 remaining, Sonnet) | ~$20–30 | Post-launch |
| Phase 2 — CICM Alpha | MCQs/Vivas (generation) | ~$90–140 | Post-launch |
| **Phase 2 subtotal** | | **~$190–290** | |
| Phase 3 — ACEM Beta | MCQ completion (382 questions) | ~$80–130 | Deferred |
| Phase 3 — ACEM Beta | LOs (609, Sonnet) | ~$80–120 | Deferred |
| **Phase 3 subtotal** | | **~$160–250** | |
| **Total remaining** | | **~$815–1,005** | |
| **Midpoint** | | **~$910** | |

**Note:** BYPASS_AUTH is **hardcoded FALSE** in the current codebase (`components/auth/AuthGate.tsx:6`). The strategic-review-2026-04-07.md incorrectly states it is `true` at lines 36 and 129 — this is stale/wrong and should be corrected.

---

## 2. Unit Economics — AUD $49/mo Subscription

### Per-Subscriber Economics

| Line item | Per subscriber/month | Notes |
|-----------|---------------------|-------|
| **Revenue** | AUD $49.00 (USD $31.85) | At 0.65 AUD/USD |
| Stripe fee | −AUD $1.72 (2.9% + $0.30) | Standard AU processing |
| **Net revenue** | **AUD $47.28** | |
| Hosting (Vercel, prorated) | ~−AUD $0.50 | $50/mo ÷ 100 users |
| DB (Supabase, prorated) | ~−AUD $0.25–0.50 | $25–50/mo ÷ 100 users (333K chunks needs Pro tier) |
| Redis (Upstash, prorated) | ~−AUD $0.05 | $5/mo fixed |
| Sentry (prorated) | ~−AUD $0.10–0.26 | Free–$26/mo |
| Claude API (session use) | ~−AUD $0.50–2.00 | SAQ grading + VIVA per session; highly variable |
| OpenAI (Whisper/TTS, session) | ~−AUD $0.10–0.30 | VIVA mode only |
| **Variable COGS total** | **~AUD $1.50–3.60** | At 100 users, session-dependent |
| **Contribution margin** | **~AUD $43.70–45.80** | **~90–94% gross margin** |

**ASSUMPTION (flag for Rafael):** Claude API session costs are the largest variable. A power user running 50 SAQ sessions/month at ~$0.04/grading call = $2.00/month. A light MCQ-only user = ~$0.05. Margin is highly usage-pattern dependent. Recommend: cap free-tier AI calls, not paid-tier (paid users are the ones worth investing in).

**ASSUMPTION (flag for Rafael):** AUD/USD rate used = 0.65. As of 2026-04-07 this is plausible but verify before publishing pricing.

---

### Pricing sensitivity

| Price point | Gross margin (est.) | Notes |
|-------------|--------------------|----|
| AUD $39/mo | ~88–92% | Undercuts courses more aggressively |
| **AUD $49/mo** | **~90–94%** | **Modelled above — recommended** |
| AUD $59/mo | ~92–95% | Business plan default (ANZCA); higher but less validated |
| AUD $69/mo (CICM) | ~93–95% | Business plan default (CICM) |

At any of these price points, gross margin is very high once fixed costs are spread across 50+ users. The business is not margin-constrained — it is **acquisition-constrained**.

---

## 3. Burn Rate

### Current monthly burn (no revenue)

| Item | Monthly (AUD) | Monthly (USD) |
|------|--------------|---------------|
| Vercel hosting | ~$20–50 | ~$13–33 |
| Supabase (Pro, needed for 333K chunks) | ~$25–50 | ~$16–33 |
| Upstash Redis | ~$5 | ~$3 |
| Sentry | ~$0–26 | ~$0–17 |
| Anthropic Claude (dev/test calls) | ~$20–50 | ~$13–33 |
| OpenAI (dev/test) | ~$10–20 | ~$7–13 |
| **Operational total** | **~$80–196 AUD/mo** | **~$52–129 USD/mo** |
| **Midpoint** | **~$138 AUD/mo** | **~$90 USD/mo** |

**Enrichment is NOT a monthly recurring burn** — it is lumpy one-time spend per pipeline run. The next two runs are:
- SAQ citations: ~$85 (1-2 hours, can run anytime)
- VIVA model_answer: ~$380 (overnight, single run)

These are capital expenditure on content, not operating expenses.

---

## 4. 90-Day Cash Forecast

Assumptions: Phase 1 enrichment runs in Month 1. No revenue until paywall exists (minimum Month 2, realistically Month 3). Operational burn continues.

| Month | Enrichment spend | Operational | Revenue | Net | Cumulative |
|-------|-----------------|-------------|---------|-----|-----------|
| April 2026 (Month 1) | ~$465 (USD) | ~$90 USD | $0 | −$555 | −$555 |
| May 2026 (Month 2) | $0 (deferred) | ~$90 | $0–small | −$90 | −$645 |
| June 2026 (Month 3) | $0 | ~$90 | $0–small | −$90 | −$735 |
| **90-day total** | | | | | **~−$645–735 USD** |

If Phase 2 (CICM, ~$340 midpoint) is also run in this window:
- 90-day total: ~−$985–1,075 USD

**Key insight:** The 90-day cash exposure is bounded and manageable. $735–1,075 USD over 90 days is not a burn crisis — it is a defined content investment with a clear endpoint.

**Threshold to watch:** If enrichment costs exceed $1,500 USD total (all phases complete), that represents a hard stop before reassessing ROI.

---

## 5. Breakeven Model: What MRR Covers Remaining Enrichment?

### Framing

Remaining enrichment (~$910 USD midpoint) is a one-time cost. "MRR to cover it" depends on recovery period:

| Recovery period | Required MRR (USD) | Subscribers needed (70% margin) | Subscribers needed (90% margin) |
|----------------|-------------------|--------------------------------|--------------------------------|
| 1 month | $910 | **41 subscribers** | **32 subscribers** |
| 3 months | $303/mo | **14 subscribers** | **11 subscribers** |
| 6 months | $152/mo | **7 subscribers** | **5 subscribers** |
| 12 months | $76/mo | **4 subscribers** | **3 subscribers** |

**Per-subscriber contribution at 70% margin:** AUD $49 × 0.70 / 0.65 = USD $22.31/sub/mo  
**Per-subscriber contribution at 90% margin:** USD $28.67/sub/mo

### Operational breakeven (ongoing only)

Monthly operational burn: ~$90 USD (midpoint)  
Subscribers to break even on operations only: $90 / $22.31 = **4.0 subscribers at 70% margin**

This is trivially achievable on Day 1 of launch. The enrichment cost is the real question.

### Recommended target: 30-subscriber beta launch

| Scenario | Outcome |
|----------|---------|
| 30 subscribers at AUD $49/mo | AUD $1,470/mo MRR = USD $955 |
| At 90% gross margin | USD $860/mo contribution |
| Phase 1 recovery time | ~1.1 months |
| Full enrichment recovery ($910 remaining) | ~1.1 months at 30 subs |
| Full spend recovery ($1,949 total) | ~2.3 months at 30 subs |

**30 subscribers is the magic number: all enrichment spend (total $1,949 USD) recovers in under 3 months.**

---

## 6. Financial Decision: Is the Remaining $910 Justified?

**YES — with Phase 1 ring-fenced.**

| Question | Answer |
|----------|--------|
| Is Phase 1 ($465) essential to launch? | Yes. SAQ confidence scores broken without citations. VIVA is a core differentiator; outlines-only is not a product. |
| Does Phase 1 complete ANZCA content? | Yes (to beta quality). |
| Is Phase 2 ($270-290) optional for launch? | Yes. CICM can wait for ANZCA revenue validation. |
| Is Phase 3 ($160-250) speculative? | Yes. ACEM has 0 LOs, no SAQs. Defer entirely until CICM is live. |
| What does $465 buy? | A complete, launch-ready ANZCA product. |
| Payback at 10 subscribers? | $465 / (10 × $22.31) = 2.1 months. |
| Risk if zero subscribers? | $465 sunk — but content moat remains, reusable for future launches. |

**Recommended decision: Run Phase 1 now ($465). Gate Phase 2 on first revenue signal (≥10 subscribers). Gate Phase 3 on CICM revenue signal.**

---

## Open Questions for Rafael

1. **Pricing validation:** Has AUD $49/mo (or $59/mo for ANZCA per business_plan.md) been tested against beta users for willingness-to-pay? The model above uses $49 as instructed but the strategic plan shows $59 for ANZCA — clarify before Stripe goes live.
2. **Supabase tier:** Is the project on Supabase Free or Pro? 333,804 document chunks + pgvector at scale likely requires Pro ($25/mo). Confirm actual invoice.
3. **Hosting costs:** What is the actual Vercel bill? Estimate above uses $20-50/mo. Confirm.
4. **Exchange rate commitment:** AUD/USD = 0.65 used. Lock in a rate assumption before setting AUD pricing if significant USD costs are expected.
5. **ACEM strategy:** Is ACEM Year 1 or Year 2 the target? If Year 2 only (or unclear), Phase 3 enrichment ($160-250) should be fully deferred — save the cash.

---

## Summary Table

| Metric | Value |
|--------|-------|
| Total enrichment spent | ~USD $1,039 |
| Phase 1 remaining (ANZCA launch) | ~USD $465 |
| Phase 2 remaining (CICM alpha) | ~USD $190–290 |
| Phase 3 remaining (ACEM beta) | ~USD $160–250 |
| **Total remaining (all phases)** | **~USD $815–1,005** |
| Monthly operational burn | ~AUD $80–196/mo (~USD $52–129) |
| Gross margin (est.) | ~90–94% |
| Operational breakeven | **4 subscribers** |
| Phase 1 payback at 10 subs | **2.1 months** |
| All-enrichment payback at 30 subs | **~2.3 months** |
| 90-day cash out (Phase 1 only) | **~USD $645–735** |
| 90-day cash out (Phase 1 + CICM) | **~USD $985–1,075** |

---

*Vault file: `vault/synapse/financial-analysis-2026-04-07.md`*  
*Evidence: knowledge/projects/synapse/review-context.json (enrichment pipeline, database state, businessContext)*  
*Linked: [[strategic-review-2026-04-07]]*
