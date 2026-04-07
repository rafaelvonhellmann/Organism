# Strategic Review: Synapse — ANZCA Primary Beachhead
**Date:** 2026-04-07  
**Task:** ab6652f3-4a7e-4a23-bf38-49e2d4718c90 (re-run)  
**Evidence:** tasks/master_tasklist.md (verified 2026-04-03), tasks/business_plan.md, tasks/cross_college_analysis.md, lib/exam-config.ts

---

## 1. Product-Market Fit: ANZCA Primary Beachhead

### The Fit

ANZCA Primary is the right beachhead. Evidence:

**Market gap is real and unserved:**

| What competitors offer | What Synapse offers | Advantage |
|---|---|---|
| Static recalled MCQ banks (AnaesthesiaMCQ.com, Black Bank) — free | AI-graded SAQs with Claude vision | No competitor does this |
| Anki decks (~$50-100 one-off, no AI) | Viva simulation with voice AI | No competitor does this |
| One-shot in-person courses (A$990-2,000 for 5 days) | Spaced repetition + adaptive progress | Continuous access vs event |
| No competitor covers MCQ+SAQ+VIVA in one platform | Unified platform, one login | Network effect for CICM/ACEM expansion |

**Content is nearly complete for ANZCA:**
- LOs: 330/330 enriched (Opus, avg 39K chars, 99.8% ground truth recall) ✅
- MCQs: 1,427/1,427 enriched ✅  
- SAQs: 551/551 (458 missing citations — re-enrichment queued, ~$85) ⚠️
- VIVAs: 1,764 have outlines only, zero model_answer — **the last major gap**
- Document chunks: 301K ANZCA rows from 47 books ✅

**PROBLEM:** Two blockers prevent ANZCA launch:
1. SAQ citations missing on 458/551 (83%) questions — confidence scores absent, citation display broken
   - Evidence: master_tasklist.md line 30: "only 93 have confidence scores (458 missing citations)"
2. VIVA model_answer NULL on all 1,764 questions — viva mode currently serves outlines only, not exam-quality answers
   - Evidence: master_tasklist.md line 188: "model_answer column is NULL on all 1,764 current ANZCA vivas"

**PROBLEM:** Auth is bypassed (`BYPASS_AUTH = true`, Session 8, master_tasklist.md line 67). Platform has no login wall, which means no user accounts, no progress persistence, and no paywall is possible.

**SOLUTION (both):**
1. Run SAQ re-enrichment (458 questions, Sonnet, ~$85) — 1-2 hour unattended script run
2. Run Viva model_answer enrichment (1,764 questions, Sonnet, ~$380) — overnight run
3. Redesign auth page (Session 9 priority, master_tasklist.md §2) — email/password + magic link. Re-enable `BYPASS_AUTH = false` after.

### PMF Confidence: HIGH (pending auth + viva completion)

Differentiators that hold after launch:
- **Moat 1:** Content — 47 books embedded, 330 LOs at Opus-quality, 1,764 viva questions. This took ~$1,039 and months of pipeline work. A copycat starts from zero.
- **Moat 2:** Domain expertise — Rafael is ANZCA-trained. Prompt quality and question accuracy cannot be replicated by a generalist AI wrapper.
- **Moat 3:** Multi-college expansion path — CICM 81.8% topic overlap with ANZCA (cross_college_analysis.md). CICM users get ANZCA content almost for free; ACEM MCQs already cross-pollinated (1,161 loaded).

---

## 2. 80/20 Analysis: Remaining Enrichment Work

### What's Done vs Remaining

| College | Item | Status | Cost |
|---|---|---|---|
| ANZCA | LOs (330) | ✅ Done | ~$293 (session 1 + Apr 2) |
| ANZCA | MCQs (1,427) | ✅ Done | ~$59 |
| ANZCA | SAQs (551 enriched, 458 missing citations) | ⚠️ Citations queued | ~$85 remaining |
| ANZCA | Viva model_answer (1,764) | ❌ Not started | ~$380 remaining |
| CICM | LOs (247) | ❌ Reset to 0 after data clean | ~$80-120 remaining |
| CICM | SAQs (657) | ❌ Not started (A/B test done) | ~$100-150 remaining |
| CICM | MCQs (264) | ❌ Not started | ~$50-80 remaining |
| CICM | Vivas | ❌ Not started | ~$40-60 remaining |
| ACEM | MCQs (382 missing answers) | ❌ Not started | ~$80-130 remaining |
| ACEM | LOs (609) | ❌ Not started | included above |

**Total estimated remaining: ~$815-1,005**

### The 80/20 Verdict

**20% of work → 80% of launch value:**

**Must-do before ANZCA launch (A$465 total):**
1. ANZCA SAQ citations (~$85) — without citations, confidence scores are blank, quality signal is absent
2. ANZCA Viva model_answer (~$380) — VIVA mode is a core differentiator; outlines-only is not a product

Everything else (CICM, ACEM enrichment) is expansion, not launch. Skip until ANZCA Beta revenue validates the model.

**Skip for now (A$350-540, defer to post-launch):**
- CICM LO/SAQ/MCQ/Viva enrichment — CICM can launch with partial content after ANZCA proves the model
- ACEM MCQ generation — ACEM is the most incomplete college (0/609 LOs, 0 SAQs)
- Benchmark fact extraction ($31 Sonnet) — quality loop improvement, not blocking

**PROBLEM:** Benchmark fact extraction script exists (`processor/extract_benchmark_facts.cjs`, ~$31 Sonnet) but has never been run. The quality_loop.cjs cannot measure fact recall without it.  
**SOLUTION:** Run benchmark extraction before final ANZCA enrichment validation. $31 against $465 of enrichment spend is cheap insurance.

**PROBLEM:** ACEM is 75% complete on MCQs (1,161/1,543) but has 0/609 LOs and 0 SAQs. It cannot launch without LOs.  
**SOLUTION:** Defer ACEM enrichment entirely until post-ANZCA launch. Cross-pollinated MCQs provide a starting point for beta users without blocking ANZCA.

---

## 3. Revenue Model Gap

### Current State

**PROBLEM:** No paywall exists anywhere in the codebase. No Stripe integration, no subscription check, no free/paid tier gating.  
Evidence: master_tasklist.md line 279: `[ ] Free/paid tier gating (Stripe + subscription check)` — listed in Security Phase 2, not started.  
Auth is currently bypassed (`BYPASS_AUTH = true`).

**Impact:** The platform has zero revenue path. Every user who signs up after launch gets full access indefinitely. This cannot ship as-is.

### Recommended Model (from tasks/business_plan.md)

The business plan already exists and is sound:

| Tier | Access | Price |
|---|---|---|
| Free | 20 MCQs, 2 SAQs with grading, 1 demo Viva (5 min) | Free |
| ANZCA Full | Complete MCQ + SAQ + Viva + SM-2 + LOs | A$59/month or A$249/6 months |
| CICM Full | — | A$69/month or A$349/6 months |
| ACEM Full | — | A$49/month or A$199/6 months |

**SOLUTION — implementation order:**

1. **Auth first** (Session 9): Rebuild auth page (email/password + magic link). Re-enable `BYPASS_AUTH = false`. This is a prerequisite for any paywall.
2. **Free tier gating** (Session 10): Add `is_paid` flag to user profile. Gate content API routes behind Supabase RLS check on subscription status. Show upgrade prompt at free tier limits.
3. **Stripe integration** (Session 10-11): Stripe Checkout → webhook → set `is_paid = true` in DB. College-specific product IDs. Subscription management portal.

**ASSUMPTION (flag for Rafael):** Business plan pricing (A$59/month ANZCA) was set 2026-03-31. Validate this against willingness-to-pay from closed beta before locking in. In-person courses cost A$990-2,000 for 5 days — Synapse's full 6-month access at A$249 is dramatically cheaper, which supports the price point.

---

## 4. 30/90/180-Day Roadmap

### Assumptions
- Today: 2026-04-07
- Auth bypass is currently on (BYPASS_AUTH = true)
- ANZCA enrichment gaps: SAQ citations ($85) + Viva model_answer ($380)
- No Stripe, no paywall, no production-ready auth

---

### 30 Days: ANZCA Launch-Ready (by 2026-05-07)

**Goal:** ANZCA content complete + auth working + closed beta opens

| Priority | Task | Cost | Effort |
|---|---|---|---|
| 1 | Auth page redesign (email/password + magic link, BYPASS_AUTH = false) | $0 | 1 session |
| 2 | ANZCA SAQ re-enrichment (458 missing citations) | ~$85 | Overnight run |
| 3 | ANZCA Viva model_answer enrichment (1,764) | ~$380 | Overnight run |
| 4 | Run validate_enrichment.cjs + quality_loop.cjs (30 samples) | ~$31 | 1 session |
| 5 | Closed beta: 20-30 trainees, free access, structured feedback form | $0 | 1 session |

**Gate:** Do not open beta until auth is re-enabled and viva model_answer > 0.

---

### 90 Days: Revenue + CICM Alpha (by 2026-07-07)

**Goal:** First paying users. CICM content ready for alpha.

| Priority | Task | Cost | Effort |
|---|---|---|---|
| 1 | Stripe integration + free/paid tier gating | $0 (Stripe fees on revenue) | 2-3 sessions |
| 2 | Early adopter launch: ANZCA Full at 30% discount, first 50-100 users | $0 | Marketing |
| 3 | CICM LO enrichment (247, Opus) | ~$80-120 | Overnight run |
| 4 | CICM SAQ enrichment (657, Sonnet) | ~$100-150 | Overnight run |
| 5 | CICM MCQ enrichment (264) + Viva generation | ~$90-140 | Overnight run |
| 6 | CICM alpha access for paid ANZCA users (loyalty feature) | $0 | 1 session |

**Revenue target at 90 days:** 50 ANZCA Full users @ A$41.50/month (6-month plan) = A$2,075 MRR. This covers ongoing API costs (~$200-300/month at scale).

**ASSUMPTION (flag for Rafael):** CICM trainees are a subset of physicians who also did ANZCA training. Bundling CICM access as a loyalty feature for existing ANZCA users is a low-cost acquisition strategy worth testing.

---

### 180 Days: ACEM + Public Launch (by 2026-10-07)

**Goal:** All three colleges live. Public launch with full marketing.

| Priority | Task | Cost | Effort |
|---|---|---|---|
| 1 | ACEM MCQ completion (382 missing answers + AI generation for anatomy/pathology) | ~$80-130 | 1-2 sessions |
| 2 | ACEM LO enrichment (609, Sonnet/Opus) | ~$150-200 | Overnight run |
| 3 | Integrated ACEM Viva UI (5-component scoring per exam-config.ts) | $0 | 2-3 sessions |
| 4 | Public launch: remove early adopter pricing, standard rates, marketing push | $0 | Event |
| 5 | Analytics engine: cross-college topic prediction (data ready) | $0 | 1 session |
| 6 | 10-15% price increase for Year 2 (business_plan.md §2.2) | $0 | Config change |

**Revenue target at 180 days:**  
- 150 ANZCA Full + 50 CICM Full + 30 ACEM Free → convert 30% → ~10 ACEM paid  
- ~210 paid users × avg A$45/month effective = A$9,450 MRR  
- Year 1 ARR trajectory: ~A$113K

---

## Open Questions for Rafael

1. **Pricing validation:** Is A$59/month for ANZCA grounded in willingness-to-pay conversations, or theory? Closed beta is the place to test this before Stripe goes live.
2. **CICM timing:** Should CICM content launch concurrently with ANZCA or sequentially? Concurrent means more parallel enrichment spend now; sequential means ANZCA revenue funds CICM build.
3. **BYPASS_AUTH timing:** How soon can auth redesign happen? The entire paywall and beta timeline gates on this being done first.
4. **ACEM strategy:** ACEM MCQ exam format differs significantly (180 MCQ + EMQ + integrated viva, no SAQs). Is Rafael targeting ACEM Year 1 or Year 2? If Year 2, ACEM enrichment spend ($230-330) should be deferred entirely.

---

*Vault file: `vault/synapse/strategic-review-2026-04-07.md`*  
*Evidence checked: master_tasklist.md (2026-04-03), tasks/business_plan.md, tasks/cross_college_analysis.md, lib/exam-config.ts*
