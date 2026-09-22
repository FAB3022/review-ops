# Negative Review Removal (NRR): Command Center handover

**For:** Joseph (Command Center build)
**Status:** logic is final and tested in the standalone dashboard (v5.2). It needs a home with shared data, logins and scheduled jobs, which is the Command Center.
**Proposal of record:** `NRR_Proposal_v2.7_for_Erik.docx`. **Operating standard:** *Negative Review Removal Master SOP v1.0* (9 Sep 2026, in `Erik Docs/`). Erik has confirmed: internal-only, no MajestIQ, and no filing on products with Canadian buyer reviews.
**AI build:** see [`AI_CLASSIFIER_SPEC.md`](AI_CLASSIFIER_SPEC.md) for the reject-first classifier, drafter, validators and learning loop.

| | |
|---|---|
| Live reference app | https://fab3022.github.io/review-ops/ |
| Source | `index.html` in this repo (single file: HTML, CSS and JS) |
| Tests | `qa/regression.js`: 91 checks, run with `npm i playwright-core && node qa/regression.js index.html` |

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

## 1a. SOP v1.0 rules the port must keep
- **Tiers:** Tier 1 = file; Tier 2 = hold (no clean named section, e.g. a different product, a complaint about Amazon itself, a scam accusation, a medical claim; not filed in Phase 1); Tier 3 = never file.
- **Purity gate (SOP Gate 2):** any statement about the product itself anywhere in the review → Tier 3, for every section except whole-content ones (language, spam, plagiarism).
- **Disqualifiers:** refund or replacement from us; our offers or contact outside Amazon; competitor comparisons; value comments; informal language; Spanish on Amazon.com; rating-content mismatch.
- **Filing (SOP section 8), exactly five parts:**
  1. Identifiers: ASIN, product, review title, reviewer, date, URL, Order ID.
  2. "Guideline section: …"
  3. "The review states [in full]: "…""
  4. One tie sentence in Amazon's words.
  5. "We request removal of this review under the cited guideline."

  ≤150 words, no links, no argument about the reviewer.
- **Phase 1 cadence:** 3 per week; 48 hours between filings on the same ASIN; at most 2 per ASIN per 30 days; no Tier 2; one refile only after 21 days with no removal, and never after a decline.
- **Channels:** primary is Brand Registry → Report a Violation → Other issues; secondary is the "Report" link under the review; compensation cases use the Report Review Compensation form. **community-help@amazon.com is retired.**
- **Measurement:** control set, true incremental rate, attribution and sweep detection (see the AI spec, section 5).

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
| 3b | `CANADA_REVIEWS` | **Erik, 22 Sep 2026:** the review is Canadian, or its ASIN or parent appears in any Canadian review (`state.canadaAsins`, built from every Canada-tab row). Canada tabs are read first, and existing reviews are re-screened when the list grows |
| 4 | `PRIOR_FILING` | No other case exists for this Amazon review ID, **open or closed** (never file the same review twice). The review's own case does not count |
| 5 | `NO_MARKETPLACE_MATCH` | Marketplace is enabled in settings **and** at least one active policy covers it |
| 6 | `STALE_POLICY` | Not every applicable policy is older than `stalenessDays` (30) |
| 7 | `EXCLUSION_MATCH` | *(after classification)* The review contains one of the matched policy's `exclusionKeywords` |
| 8 | `NO_EVIDENCE_QUOTE` | *(after classification)* The evidence is at least 4 characters and appears verbatim in title + text |

### 2.3 Classifier (`classifyReview`)
**Source of truth:** Amazon's Community Guidelines, "What's not allowed" (amazon.com, read 21 Sep 2026, PDF in the project folder), plus the Seller Central pages *Customer product reviews policies* (GYRKB5RU3FS5TURN) and *Answers to questions about reviews* (201972160). Every case quotes Amazon's own words. An independent check confirmed every quoted string is verbatim.

Default verdict is **NOT ELIGIBLE**. Text = `title + "
" + text` (the line break keeps the evidence quote to one real sentence). Matching runs on a copy with straight apostrophes, so phone-typed `’` still matches; evidence is quoted from the original text.

1. **Rating 4–5 → NOT ELIGIBLE**, never a candidate.
2. **Safeguard 1 (`SELLER_REVIEW_CONTACT`) → NOT ELIGIBLE, never report:** the review mentions our team offering a refund, gift, discount or anything else in connection with a review, or asking the buyer to change or remove it. Amazon lists these as *seller* violations.
3. **Safeguard 2 (`OFF_AMAZON_CONTACT`) → NOT ELIGIBLE, never report:** the review mentions contact, a website, a guarantee or contact details on packaging outside Amazon. Seller Central requires all customer contact to stay in Buyer-Seller Messaging.
4. **Listing mismatch (`LISTING_MISMATCH`):** colour, size or look "not like the pictures" is product feedback, so the Seller/order detectors are skipped.
5. The first matching detector in `DETECTORS` wins. There is one policy per Community Guidelines section; `bullet` is the exact sub-bullet quoted in the case.

| Policy | Community Guidelines section | What it matches | Verdict |
|---|---|---|---|
| `POL-PERSONAL` | Private information | email, order number (`\d{3}-\d{7}-\d{7}`), phone (3-3-4), mailing address | CLEAR |
| `POL-PROFANITY` | Profanity or harassment | profanity list (CLEAR); name-calling of people, not self (HOLD); "scam/fraud/thieves" accusations = libel/defamation (HOLD) | CLEAR / HOLD |
| `POL-COMPENSATED` | Compensated or incentivized reviews | reviewer's own incentive ("in exchange for an honest review"); exclusion keyword `vine` | CLEAR |
| `POL-PROMO` | Ads, conflicts of interest, promotional content | conflict of interest ("I work for a competitor"), promo codes, "visit our website", social handles | CLEAR |
| `POL-LINKS` | External links | non-Amazon URLs; Amazon URLs with `tag=`/`ref=` affiliate codes (plain Amazon links are allowed) | CLEAR |
| `POL-PRICING` | Comments about pricing or availability | price elsewhere or at a named store ("go to your local Walmart"), price changes, price gouging (value comments not matched) | Tier 1; Tier 3 if any product statement |
| `POL-WRONGPRODUCT` | Review of a different product (no named section; SOP Tier 2) | textile listing + ≥2 foreign-product terms (assemble, planks, bed frame, batteries…) | Tier 2 |
| `POL-SELLER` | Seller, order, or shipping feedback | one detector per sub-bullet: *Sellers and the Customer Service they provide*; *Ordering issues and returns* (wrong item, refund delays, missing items, empty box, never opened); *Product condition and damage* (used, opened, bugs, defects on arrival = HOLD); *Shipping packaging*; *Shipping cost and speed* | Tier 1 if only about the order; Tier 3 if any product statement; Amazon-itself = Tier 2 |
| `POL-MEDICAL` | Medical claims | "cured my eczema/insomnia…" | HOLD |
| `POL-REPETITIVE` | Repetitive text, spam, or pictures created with symbols | symbols only, repeated words, keyboard-mash gibberish | CLEAR |
| `POL-LANGUAGE` | Content written in unsupported languages | stopword language detection vs `SUPPORTED_LANGS` (US en/es stated by Amazon; CA en/fr, MX es/en, BR pt still to confirm); mixed-language = HOLD | CLEAR / HOLD |
| `POL-PLAGIARISM` | Plagiarism, infringement, or impersonation | same ≥40-character text on another ASIN | HOLD |
| `POL-HATE`, `POL-SEXUAL`, `POL-ILLEGAL` | Hate speech; Sexual content; Illegal activities | no automatic detector; add detection keywords on the Policies page | HOLD via keywords |
| any | manual keywords | the policy's `keywords` | HOLD |

6. **Verdict rules (SOP v1.0).** The review minus the matched phrase is checked for product statements (`PRODUCT_TALK`, which includes materials such as silk, satin and microfiber):
   - any product statement → **Tier 3** (purity gate; not applied to language, spam or plagiarism);
   - only a general opinion word ("nice", "love") → **Tier 2**, for a person to judge;
   - `tier2Only` policies (different product) → **Tier 2**;
   - otherwise confidence ≥ 80 → **Tier 1**, below 80 → **Tier 2** (Amazon-itself complaints, name-calling, defamation, medical claims).
   Never-delivered orders are cited as *Ordering issues and returns* (SOP), not the compensated-reviews bullet.
7. Store `{policyId, bullet, confidence, evidence, rationale}` on the review. The verdict is **separate** from workflow state; nothing advances automatically.

**Not removable per Seller Central (never flag):** reviews comparing our product with a competitor's ("Can Amazon remove a review that compares my product with a competitor's product…? No.").

**Calibration (21 Sep 2026):** two independent reviewers judged every flagged review against the PDF, and four more read all 735 unflagged negative reviews. The shipped rules match at least one reviewer on 27 of 30 flagged reviews; the other 3 differ in the cautious direction (HOLD where reviewers said not eligible). They also catch 8 of the 10 strong misses the reviewers found. **Do not loosen the rules without re-running this baseline.**

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
Guideline basis: <policy.caseStatement with {bullet} = the exact sub-bullet>   (Amazon's verbatim wording)
Seller Central policy: <policy.url>          (primary reference: Customer product reviews policies, GYRKB5RU3FS5TURN)
Community Guidelines: <policy.guidelineUrl>
Text in the review: "<evidence>"
We request that Amazon review this content against the Community Guidelines and
remove it if it does not comply.
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
| `policies` | id, heading, marketplaces[], guidance, **caseStatement**, url (Seller Central policy link, primary), **guidelineUrl** (Community Guidelines), **keywords[]**, exclusions, **exclusionKeywords[]**, lastChecked, owner, status, route (constant) |
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

**Full-history scan (reference app):** `scanFullHistory()` reads every row of every review tab, analyses 1–3★ reviews in memory and keeps only CLEAR/HOLD candidates, because browser storage can't hold the ~5,000-review history. Once the Command Center has a database, store every review and run the classifier over all of them. Keep the rule that non-candidates never show validation or approval controls.

---

## 5. Notifications (channel to be confirmed)
Validation needed · approval needed (to the brand's BM) · case ready to submit · check-date due · auto-pause triggered · resumed.

---

## 6. Acceptance
1. Port `qa/regression.js` scenarios (91) to the Command Center test suite.
2. **Baseline:** a full Master File run on 21 Sep 2026 must reproduce **4,867 reviews, 765 rated 1–3★; with the Canada exclusion and the SOP purity gate: 522 blocked `CANADA_REVIEWS` (376 ASINs/parents), 3 Tier 1, 2 Tier 2, 236 Tier 3, 2 `NO_MARKETPLACE_MATCH` (US only)**. Differences mean the rules drifted.
3. Walk the 10-review test set (`seedTestReviews`) end to end with a real AB and a real BM account.

## 7. Reporting route
The route stays **Brand Registry → Report a Violation → Other Issues** (Erik's instruction). Per SOP v1.0: the **"Report"** link under the review is the secondary channel, and the **Report Review Compensation form** is for compensation cases. **community-help@amazon.com is retired** (an Amazon moderator confirmed in 2026), even though an older Seller Central page still lists it. Seller Central → Report Abuse is for attacks by competitors.

## 8. Open items
- Erik to confirm the notification channel, weekly cap (proposed 5/week), follow-up cap (proposed 2) and Protected ASIN additions.
- Confirm the extraction engine is running (moving from Ayush's laptop to the Mac mini, PR #149) and exposes review ID + link.
- Phase 1 scope: DECOLURE bamboo lines, US only, via the approved-for-filing list.
