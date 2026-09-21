# Negative Review Removal (NRR): Command Center handover

**For:** Joseph (Command Center build)
**Status:** logic is final and tested in the standalone dashboard (v5.2). It needs a home with shared data, logins and scheduled jobs, which is the Command Center.
**Proposal of record:** `NRR_Proposal_v2.4_for_Erik.docx` (Erik has confirmed: internal-only, no MajestIQ).

| | |
|---|---|
| Live reference app | https://fab3022.github.io/review-ops/ |
| Source | `index.html` in this repo (single file: HTML, CSS and JS) |
| Tests | `qa/regression.js`: 52 checks, run with `npm i playwright-core && node qa/regression.js index.html` |

The reference app runs entirely in the browser (`localStorage`). Treat it as the **specification**, not the production system. Port the logic below. Do not embed the page.

---

## 1. What has to move into the Command Center

| Needed | Why the reference app can't do it | Command Center piece |
|---|---|---|
| Shared database | Data lives in each person's browser; AB and a BM on different machines see different queues. The browser also can't hold the ~5,000-review history (storage quota exceeded) | Tables in §3 |
| Logins and roles | Approver names are typed in, so "AB ≠ BM" is enforced only by name | AB, Brand Manager, Validator, Submitter, Viewer (read-only) |
| Review ingestion | Sync reads the Master File via the public `gviz` CSV link, so the sheet must be shared as "anyone with the link". Most rows have no Amazon review ID | Feed from **Ayush's review extraction engine** (has review ID and link); Master File as fallback |
| Scheduled jobs | The "Monday sync" only runs when someone opens the page on a Monday | Cron: daily ingest (or at least Monday 7-day pull) and daily stop-condition check |
| Notifications | Channel name is stored, but nothing sends | Slack alerts (channel still to be confirmed by Erik) |
| Private access | Reference app is on a public URL | Behind Command Center auth |

**Never build:** any automated submission to Amazon. Submission stays a human action through **Brand Registry → Report a Violation → Other Issues**.

---

## 2. Pipeline

```
ingest → dedupe → SCREEN (8 gates) → CLASSIFY → post-gates (7, 8)
       → VALIDATE (human) → APPROVE (AB + BM) → DRAFT → SUBMIT (manual)
       → MONITOR → FOLLOW-UP → CLOSE → success rate / auto-pause
```

### 2.1 Dedupe on ingest
Duplicate if the same `reviewId`, the same `sourceRef`, or the same `asin + marketplace + text` (text compared trimmed, case-insensitive).
If there is no review ID but the link matches `/customer-reviews\/(R[A-Z0-9]{8,})/i`, take the ID from the link.

### 2.2 Screening gates (strict order, first failure wins, record `block_reason` + detail)

| # | Code | Rule |
|---|---|---|
| 1 | `MISSING_DATA` | `asin`, `brand`, `marketplace`, `text`, `reviewDate` all present; `rating` 1–5 |
| 2 | `REVIEW_REMOVED` | `sourceRemoved` flag not set |
| 3 | `PROTECTED_ASIN` | ASIN, or its parent from the ASIN catalogue, is on the active Protected register for this marketplace (or `ALL`) |
| 4 | `PRIOR_FILING` | No other case exists for this Amazon review ID, **open or closed** (never file the same review twice). The review's own case does not count |
| 5 | `NO_MARKETPLACE_MATCH` | Marketplace is enabled in settings **and** at least one active policy covers it |
| 6 | `STALE_POLICY` | Not every applicable policy is older than `stalenessDays` (30) |
| 7 | `EXCLUSION_MATCH` | *(after classification)* The review contains one of the matched policy's `exclusionKeywords` |
| 8 | `NO_EVIDENCE_QUOTE` | *(after classification)* The evidence is at least 4 characters and appears verbatim in title + text |

### 2.3 Classifier (`classifyReview`)
Default verdict is **NOT ELIGIBLE**. Text = `title + " " + text`.

1. **Rating 4–5 → NOT ELIGIBLE**, never a candidate.
2. The first matching detector in `DETECTORS` wins. There is one policy per Amazon Community Guidelines category:

| Order | Policy | Category | Confidence | Mixed check | What it matches |
|---|---|---|---|---|---|
| 1 | `POL-PERSONAL` | Personal information | 94 / 90 | no | email; real 3-3-4 phone (dates and order IDs excluded); street address |
| 2 | `POL-OFFENSIVE` | Profanity, harassment and offensive content | 90 | no | profanity list |
| 3 | `POL-INCENTIVE` | Incentivized reviews and conflicts of interest | 86 | no | "in exchange for an honest review", "received it free for", "I work for a competitor"; exclusion keyword `vine` |
| 4 | `POL-PROMO` | Promotional content and external links | 88 | no | non-Amazon URL; `use code X` (X has a digit); "cheaper version from"; "visit our store"; "buy it from <domain>" |
| 5 | `POL-PRICING` | Pricing and availability | 84 | yes | price elsewhere, price changes, "out of stock", "on sale for $X" (value comments such as "not worth the price" are not matched) |
| 6 | `POL-PROMO` | (other brands / stores) | 74 | yes | "buy X instead", "better sheets from Walmart", "other brands are better" |
| 7 | `POL-SELLER` | Seller and order feedback | 82 | yes | seller or customer-service failures, refund delays or denials, can't contact the seller |
| 8 | `POL-SELLER` | (fulfilment) | 82 | yes | never arrived, wrong size/colour sent, "ordered X but received Y", used or opened item, lost package, late delivery |
| 9 | `POL-SELLER` | (missing items) | 72 | yes | missing pieces or pillowcases (may be a product issue, so always HOLD) |
| 10 | `POL-OFFTOPIC` | Content not about the product | 80 | yes | Amazon's service, returns or refunds; delivery carrier; review of a different product |
| 11 | `POL-REPETITIVE` | Repetitive text and spam | 85 | no | repeated symbols or words, no letters at all, same text on another ASIN |
| — | any policy | manual keywords | 70 | yes | the policy's `keywords` (evidence = the containing sentence) |

3. **Verdict:** confidence ≥ 80 and no mixed content → `clear_violation`; otherwise → `hold`. **Mixed content** = the review, minus the matched phrase, also discusses the product (`PRODUCT_TALK`: fabric, fit, colour, soft, thin, stitching, tear, wash, …). Keyword matches always land as `hold`.
   **Safeguard:** never match a review alleging that *our* team offered an incentive to change or remove a review. Reporting it would draw Amazon's attention to our own conduct.
4. Store `{policyId, confidence, evidence, rationale}` on the review. The verdict is **separate** from workflow state; nothing advances automatically.

**Do not loosen these rules without re-running the baseline (§6).** An earlier looser version flagged 13 reviews on the Master File, all false positives (4–5★ praise, our own packaging discount card, a date read as a phone number).

### 2.4 Human validation
Five checks are required, plus the validator's name: source confirmed, exact quote present, live policy checked, not product-experience only, exclusions considered. Only `clear_violation` or `hold` can be validated.

### 2.5 Approvals
- AB and Brand Manager each record `{by, at, decision, notes}`. Either can reject.
- **They must be different people.** Enforce this by user account in the Command Center.
- Each approver's notes stay hidden from the other until both have decided.
- Both approvals → `approved`. The ASIN must also be on the **weekly approved-for-filing list**, if that list is non-empty (parent or child match).

### 2.6 Case draft (`caseDraft`)
Built only from stored facts. 150 words maximum (save refused above that). The evidence quote is locked (save refused if it's removed).
```
ASIN / Marketplace / Review ID / Review link
Community Guidelines category: <heading>
Guideline basis: <policy.caseStatement>
Reference: <policy.url>
Text in the review: "<evidence>"
We request that Amazon review this content against the <heading> section of the
Community Guidelines and remove it if it does not comply. We are not disputing the
customer's opinion of the product.
```
The route is a constant: `Amazon Brand Registry > Report a Violation > Other Issues` (not editable).

### 2.7 Submission, monitoring, close
- **Mark submitted** requires a named submitter. It is blocked if submissions are paused, the ASIN isn't on the approved list, or the **weekly cap** is reached. The cap counts cases by `recordedAt` (server time), never by the typed date, over a rolling 7 days.
- `nextReviewAt = submittedAt + observationDays (10)`.
- **Follow-ups:** capped at `followUpMax`. Any follow-up after the first requires the latest Amazon response to be `insufficient_info`.
- **Amazon response:** `pending | insufficient_info | declined | removed`. A case can only be closed as `removed` or `declined`, with an outcome note.

### 2.8 Priority, success rate, auto-pause
- **Priority** (candidates only): `0.45·confidence + 0.25·recency + 0.20·starImpact + 0.10·density`. Recency = `max(0, 100 − daysOld·100/90)`; starImpact = `(5 − rating)/4·100`; density = `min(100, 25 × other candidates on the same ASIN)`. The queue sorts by priority first.
- **Success rate** = removed ÷ (removed + declined) over closed cases. Show it for the last 30 days: overall, per policy and per brand.
- **Auto-pause** (sets `submissionsPaused` + reason, audit, alert):
  - an open case is on a Protected ASIN;
  - success rate is below `precisionFloor` (40%) in both of the last two 7-day windows.
- **Resume:** requires a named approver (Erik) and a root-cause note; both are audited.

---

## 3. Data model (port as tables)

| Table | Fields |
|---|---|
| `reviews` | id, reviewId (Amazon), sourceRef, asin, brand, marketplace, rating, title, text, reviewDate, reviewer, collectedAt, sourceRemoved, workflow_state (`new/screened/blocked/routed/validated/approved/drafted`), verdict, block_reason, block_detail, classification{policyId, category, confidence, evidence, rationale, at}, validation{5 checks, notes, by, at}, approvals{ab, brandManager: {by, at, decision, notes}}, updatedAt |
| `cases` | id, reviewId (FK), status (`ready/submitted/monitoring/closed`), draft, route, submitter, amazonReference, submittedAt, **recordedAt**, nextReviewAt, followUpCount, amazonResponse, outcome, closedAt, createdAt, updatedAt |
| `policies` | id, heading, marketplaces[], guidance, **caseStatement**, **keywords[]**, exclusions, **exclusionKeywords[]**, url (Amazon or Seller Central only), lastChecked, owner, status, route (constant) |
| `protected_asins` | asin, parent, brand, marketplace (`US/CA/MX/BR/ALL`), reason, owner, protectedFrom, releaseDate, status, lastChecked |
| `asin_catalog` | brand, parent, child, sku, marketplace, productName. Source: Master File SKU LIST (brand taken from the product-name prefix) |
| `owners` | role (AB / Brand Manager / Submitter), name, brands[], marketplaces[] → map to user accounts |
| `settings` | weeklyCap, observationDays, followUpMax, stalenessDays (30), marketplaces[], approvedAsins[], approvedWeekOf, precisionFloor (40), submissionsPaused, pauseReason, notificationChannel |
| `audit_log` | id, at, entityType, entityId, event, actor, before, after, comment. **Append-only. No delete path** (the reference app's "factory reset" must not exist in production) |

Seed data (8 Community Guidelines policies with `caseStatement` wording, 3 SLEEPHORIA protected ASINs, owners) is at the top of the `<script>` in `index.html`.

---

## 4. Ingestion

**Primary: Ayush's review extraction engine** (`ecotero-command-center`, `collector/`). It must supply per review: Amazon review ID, review link, ASIN (child and parent), brand, marketplace, rating, title, body, review date. The review ID is the key field; without it, the PRIOR_FILING gate and the case draft are weak.

**Fallback: Master File** (`10ZF01GX9CSdUCoLuknafA9sZOR1pgyBzQSWAMrNtFI4`), tabs `US`, `Canada`, `Mexico`, `Brazil`, `SKU LIST`. Header mapping is in `SHEET_COLUMN_ALIASES`. Known data issues:
- Canada has ~396 spacer rows with only "CA" filled; skip rows with no ASIN, brand or text.
- The Brazil tab is empty.
- SKU LIST has no Brand or Marketplace column.
- Review links exist for only ~325 US rows.
- Freshness as of 21 Sep: US 18 Sep, CA 4 Aug, MX 6 Jul.

Read it with a service account, not the public link.

---

## 5. Notifications (channel to be confirmed)
Validation needed · approval needed (to the brand's BM) · case ready to submit · check-date due · auto-pause triggered · resumed.

---

## 6. Acceptance
1. Port `qa/regression.js` scenarios (52) to the Command Center test suite.
2. **Baseline:** a full Master File run on 21 Sep 2026 must reproduce **4,867 reviews, 765 rated 1–3★, 6 CLEAR (all seller/order feedback), 26 HOLD (19 seller/order, 4 promotional, 2 not about the product, 1 pricing), 47 PROTECTED_ASIN**. Differences mean the rules drifted.
3. Walk the 10-review test set (`seedTestReviews`) end to end with a real AB and a real BM account.

## 7. Open items
- Erik to confirm the notification channel, weekly cap (proposed 5/week), follow-up cap (proposed 2) and Protected ASIN additions.
- Confirm the extraction engine is running (moving from Ayush's laptop to the Mac mini, PR #149) and exposes review ID + link.
- Phase 1 scope: DECOLURE bamboo lines, US only, via the approved-for-filing list.
