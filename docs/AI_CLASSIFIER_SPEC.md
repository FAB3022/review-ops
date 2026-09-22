# NRR AI classifier and drafter: specification

**Source of truth:** Negative Review Removal Master SOP v1.0 (9 Sep 2026), section 10, plus Amazon's Community Guidelines "What's not allowed" (read 21 Sep 2026).
**Where it runs:** the Command Center server. Never in the browser, because the model key must not be exposed.
**What it replaces:** the rule-based detectors in `index.html` become the *pre-filter and fallback*. The AI classifier makes the tier decision, and the programmatic validators below have the final say.

The EDH rationale prompt ("ALWAYS ASSERT A VIOLATION, NEVER CONCEDE", "recast…") is **not** used. SOP section 10 explains why: it has no rejection path and manufactures violations on thin cases. We keep its two-call structure and its list of policy angles, and invert the stance.

---

## 1. Pipeline

```
extracted review ──► hard gates (code) ──► CALL 1 classifier ──► validators (code) ──► human validation + AB/BM approval
                        │                                               │
                        └─ Canada family, Protected ASIN, prior filing, └─ reject the whole assessment on any failure
                           1–3★ only, safeguards
                                                   TIER_1/TIER_2 only ──► CALL 2 drafter ──► validators ──► case (≤150 words)
                                                                                         (there is no call 3: a human submits)
```

**Hard gates run in code before any model call:**
1. Rating 1–3 only (SOP Gate 1).
2. No Canadian buyer reviews on the product family (Erik, 22 Sep 2026).
3. Not on the Protected ASIN register.
4. Never filed before, and never declined (SOP Gate 5).
5. Safeguards: never file a review that mentions our team offering something in connection with a review, contact outside Amazon, or a refund or replacement from us.

---

## 2. Call 1: classifier (reject-first)

**System prompt**
```text
You are the first-line screener for Amazon customer-review removal requests. Your default answer is REJECT.
You must justify a pass; you never need to justify a rejection.

Decide whether the review PLAINLY violates one of Amazon's fourteen named Community Guidelines sections.
Do not recast, reframe, or search for the strongest available angle. Either the review plainly violates a
named section on its face, or it does not.

TIER_1 (file): the violating words can be quoted verbatim, they fall under a named section below, and the
review contains NO statement about the product itself (quality, fit, durability, colour, feel, performance,
appearance, material).
TIER_2 (hold): a real violation with no clean named section (e.g. a review describing a different product,
a complaint about Amazon itself), or a scam/fraud accusation, name-calling, or a medical claim that needs a person.
TIER_3 (never file): anything with a substantive product statement anywhere in the text; a review that is
harsh, unfair, hyperbolic or written with unrealistic expectations; a comparison with a competitor product;
colour or size "not like the pictures"; a value comment ("not worth the money"); informal language
("lol", "idk", "cheap cheap") treated as spam; Spanish on Amazon.com (supported); rating/content mismatch.

The fourteen section names (cite EXACTLY, or null):
Seller, order, or shipping feedback | Comments about pricing or availability | Content written in unsupported
languages | Repetitive text, spam, or pictures created with symbols | Private information | Profanity or
harassment | Hate speech | Sexual content | External links | Ads, conflicts of interest, promotional content |
Compensated or incentivized reviews | Plagiarism, infringement, or impersonation | Illegal activities | Medical claims

Seller, order, or shipping feedback sub-bullets (cite exactly): Sellers and the Customer Service they provide;
Ordering issues and returns; Shipping packaging; Product condition and damage; Shipping cost and speed.
Lost or never-delivered orders are "Ordering issues and returns".

Return JSON only.
```

**User prompt** (built on the server from stored fields only; never from client input)
```text
Marketplace: {US}   ASIN: {asin}   Product: {product name from the SKU LIST}
Rating: {n}/5   Date: {date}   Verified purchase: {yes|no|unknown}   Vine: {yes|no|unknown}
Review title: {title}
Review body: {body}
```

**Output schema**
```json
{
  "verdict": "TIER_1 | TIER_2 | TIER_3",
  "section": "one of the fourteen names, or null",
  "bullet": "exact sub-bullet, or null",
  "quote": "verbatim substring of the title or body, or null",
  "product_complaint_present": true,
  "rationale_for_tier": "one sentence"
}
```

**Few-shot examples** (from SOP section 9 and our calibrated baseline):
| Review | Expected |
|---|---|
| "Missing items." / "Didn't receive pillow cases." | TIER_1 · Seller, order, or shipping feedback · Ordering issues and returns |
| "Horrible" / "Used sheets was sent to me." | TIER_1 · … · Product condition and damage |
| "Open packaged no box !" / "Product was opened and no box, I am questioning if these were new or used !" | TIER_1 · … · Product condition and damage |
| Bed-frame assembly text on a satin fitted-sheet ASIN | TIER_2 · null · "describes a different product" |
| Stitching holes, non-rectangular flat sheet, then "Sent 2 e-mails to the company… never received one" | TIER_3 · product complaint present |
| "Buena calidad" / "Buena" at 1★ | TIER_3 · Spanish is supported; no rating-mismatch section |
| "They feel like plastic lol cheap cheap … idk" | TIER_3 · informal language is not spam |
| "Wrong size sent. Beautiful colour and fabric, but wrong size." | TIER_3 · product statement ("colour and fabric") |
| "Found this item here for $5 less than at my local store" | TIER_1 · Comments about pricing or availability |

---

## 3. Validators (code, after Call 1; failure discards the whole assessment)

1. `quote` must be a **literal substring** of the title or body (straight and curly apostrophes treated alike). If not, discard.
2. `section` must be one of the fourteen exact names (or null for TIER_2 "different product"). Invented names are rejected.
3. `bullet`, when given, must be one of Amazon's sub-bullets for that section.
4. `product_complaint_present === true` forces **TIER_3**. No override.
5. The rule-based detectors in `index.html` run on the same review. If they return Tier 3 via the purity gate or a safeguard, the result is **TIER_3**, whatever the model says.
6. Disagreements (model TIER_1 but rules Tier 3, or the reverse) go to a human as TIER_2 and are logged for calibration.

---

## 4. Call 2: drafter (TIER_1 and approved TIER_2 only)

**System prompt**
```text
Write an Amazon review-removal filing with EXACTLY five parts and nothing else:
1 identifiers (given), 2 "Guideline section: <section>" (given, do not change),
3 "The review states[ in full]: "<quote>"" (given, do not change),
4 ONE sentence tying the quote to Amazon's own sub-bullet, using Amazon's wording,
5 "We request removal of this review under the cited guideline."
Forbidden: more than one violation theory; any sentence about rating, sales, conversion, brand harm or urgency;
characterising the reviewer or their honesty; saying the reviewer is wrong; persuasive or emotional language;
more than 150 words. Clinical tone.
```
Inputs `section`, `bullet` and `quote` are fixed. There is no regenerate or re-roll. If the draft is wrong, the case is wrong. Part 4 should match the `caseStatement` "tie" wording in the policy register. Validators: all five parts present, the quote unchanged, ≤150 words, and no forbidden phrases (`rating`, `sales`, `our business`, `unfair`, `fake`, `lying`, `urgent`).

---

## 5. Learning from outcomes (SOP sections 11–12)

The system "learns" from measured results, never by loosening its own rules:

1. **Every negative review is kept**, including rejections, which form the control set. Outcomes come from the daily review extraction: removal detected date, and REMOVED / STILL LIVE / DECLINED / CLOSED.
2. **Control set:** Tier 1 reviews not filed (over the weekly cap) are tracked exactly like filed ones.
3. **True incremental removal rate** = filed removal rate − control removal rate, reported per section and sub-bullet.
4. **Attribution:** ATTRIBUTED (removed 1–21 days after filing, no sweep) / BACKGROUND (inside a sweep, or a control) / UNCLEAR. A **sweep** is more than 2% of tracked reviews across unrelated ASINs disappearing within 72 hours.
5. **Monthly recalibration (human-approved):**
   - Sections with a high incremental rate get their confirmed-removed cases added as few-shot examples.
   - Sections at or below zero incremental rate stop being filed (SOP: "we stop filing pricing cases").
   - Every classifier/human disagreement from the month is reviewed and becomes a labelled example.
   - The Tier 1 rate must stay within 4–8% of negative reviews. Above 8% means the classifier is too permissive, so tighten before filing.
6. Prompt and example changes are versioned. The eval set (below) must pass before a new version is used.

**Eval set:** every SOP worked example, plus the 30 reviews independently double-labelled on 21 Sep 2026, plus every human decision going forward. Target: zero TIER_1 on any review a human marked TIER_3, since false approvals are costly and false rejections are cheap (SOP Week 3).

---

## 6. What the reference dashboard already enforces
- Tier 1 / 2 / 3 labels.
- SOP Gate 2 purity (any product statement → Tier 3).
- The 14 exact section names with verbatim ties.
- The five-part filing.
- Canada family exclusion.
- Phase 1 cadence: 3 per week, 48 hours per ASIN, 2 per ASIN per month, no Tier 2.
- One refile after 21 days, never after a decline.
- Control set, attribution and the Learning and trends card.

The Command Center should keep all of these as code-level validators around the AI calls.
