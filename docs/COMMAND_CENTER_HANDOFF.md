# Negative Review Removal (NRR): Command Center handover

**For:** Joseph (Command Center build)
**Status:** logic is final and tested in the standalone dashboard (v5.2). It needs a home with shared data, logins and scheduled jobs, which is the Command Center.
**Proposal of record:** `NRR_Proposal_v2.4_for_Erik.docx` (Erik has confirmed: internal-only, no MajestIQ).

| | |
|---|---|
| Live reference app | https://fab3022.github.io/review-ops/ |
| Source | `index.html` in this repo (single file: HTML, CSS and JS) |
| Tests | `qa/regression.js`: 41 checks, run with `npm i playwright-core && node qa/regression.js index.html` |

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
2. The first matching rule wins:

| Signal | Policy | Confidence | Pattern (summary; exact regexes in `classifyReview`) |
|---|---|---|---|
| Email or phone | `POL-PERSONAL` | 94 | email; phone must be a real 3-3-4 format (dates and order IDs excluded) |
| External link or promotion | `POL-PROMO` | 88 | non-Amazon URL; `use code X` where X has a digit; "cheaper version from"; "visit our website/store"; "buy it from <domain>" |
| Seller service | `POL-SELLER` | 82 | "seller refused", "customer service never replied", … |
| Shipping or fulfilment | `POL-SELLER` | 64 | "arrived late", "box was crushed", "wrong size/colour sent", "received the wrong", "never arrived" |
| Manually added policy | that policy | 70 | any of the policy's `keywords` (evidence = the sentence containing it) |

3. **Verdict:** confidence ≥ 80 → `clear_violation`; otherwise → `hold`. A seller-policy match where the product is the main subject → `hold`. **Manually added policies always land as `hold`.**
4. Store `{policyId, confidence, evidence, rationale}` on the review. The verdict is **separate** from workflow state; nothing advances automatically.

**Do not loosen these rules without re-running the baseline (§6).** The previous looser version flagged 13 reviews on the Master File, and all 13 were false positives.

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
Policy: <heading>
Policy scope: <policy.guidance>
Reference: <policy.url>
Exact text from the review: "<evidence>"
We are asking Amazon to check this review against the <heading> policy. We are not
disputing the customer's opinion of the product. Please make the final determination
under the policy currently in effect; no outcome is assumed.
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
| `policies` | id, heading, marketplaces[], guidance, **keywords[]**, exclusions, **exclusionKeywords[]**, url (Amazon or Seller Central only), lastChecked, owner, status, route (constant) |
| `protected_asins` | asin, parent, brand, marketplace (`US/CA/MX/BR/ALL`), reason, owner, protectedFrom, releaseDate, status, lastChecked |
| `asin_catalog` | brand, parent, child, sku, marketplace, productName. Source: Master File SKU LIST (brand taken from the product-name prefix) |
| `owners` | role (AB / Brand Manager / Submitter), name, brands[], marketplaces[] → map to user accounts |
| `settings` | weeklyCap, observationDays, followUpMax, stalenessDays (30), marketplaces[], approvedAsins[], approvedWeekOf, precisionFloor (40), submissionsPaused, pauseReason, notificationChannel |
| `audit_log` | id, at, entityType, entityId, event, actor, before, after, comment. **Append-only. No delete path** (the reference app's "factory reset" must not exist in production) |

Seed data (3 policies, 3 SLEEPHORIA protected ASINs, owners) is at the top of the `<script>` in `index.html`.

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
1. Port `qa/regression.js` scenarios (41) to the Command Center test suite.
2. **Baseline:** a full Master File run on 21 Sep 2026 must reproduce **4,867 reviews, 765 rated 1–3★, 0 CLEAR, 5 HOLD (all fulfilment errors), 47 PROTECTED_ASIN**. Differences mean the rules drifted.
3. Walk the 10-review test set (`seedTestReviews`) end to end with a real AB and a real BM account.

## 7. Open items
- Erik to confirm the notification channel, weekly cap (proposed 5/week), follow-up cap (proposed 2) and Protected ASIN additions.
- Confirm the extraction engine is running (moving from Ayush's laptop to the Mac mini, PR #149) and exposes review ID + link.
- Phase 1 scope: DECOLURE bamboo lines, US only, via the approved-for-filing list.
