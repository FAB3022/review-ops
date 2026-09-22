// Regression checks for index.html (v5.2, aligned to SOP v1.0 and Final Proposal v2.7). Run: npm i playwright-core && node qa/regression.js index.html
// Uses local Chrome and pulls the live Master File tabs for the sync checks.
const {chromium}=require('playwright-core');const http=require('http'),fs=require('fs');
const html=fs.readFileSync(process.argv[2]);
const srv=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(html)}).listen(8767);
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const p=await b.newPage();await p.addInitScript(()=>{window.fillIds=()=>{const a=document.querySelector('#caseDraftArea');if(a)a.value=a.value.replace(/\[name as displayed\]/g,'Test Buyer').replace(/\[direct link\]/g,'https://www.amazon.com/gp/customer-reviews/RTEST00001').replace(/\[product name\]/g,'Test product')}});const errs=[];p.on('dialog',d=>d.accept('Erik'));p.setDefaultTimeout(60000);p.on('pageerror',e=>errs.push(e.message));
// migration from a v5.0 browser state
// (old browsers kept a v5.0 copy in localStorage; first load moves it into IndexedDB and upgrades it)
await p.goto('http://localhost:8767/');await p.evaluate(()=>window.appReady);await p.evaluate(async()=>{const s=structuredClone(state);s.policies.forEach(x=>{x.route='Seller Central > Help > Report abuse';delete x.exclusionKeywords});s.settings.scriptVersion='v5.0';await idbClear();localStorage.setItem(STORAGE_KEY,JSON.stringify(s))});
await p.reload();await p.evaluate(()=>window.appReady);await p.waitForTimeout(300);
const movedToIdb=await p.evaluate(async()=>({ls:localStorage.getItem(STORAGE_KEY),idb:!!(await idbGet())}));ok(movedToIdb.ls===null&&movedToIdb.idb,'old localStorage copy moved into the browser database (no 5 MB limit)');
const mig=await p.evaluate(()=>({routes:[...new Set(state.policies.map(x=>x.route))],ex:state.policies.every(x=>Array.isArray(x.exclusionKeywords)),v:state.settings.scriptVersion}));
ok(mig.routes.length===1&&mig.routes[0].startsWith('Amazon Brand Registry'),'migration locks route: '+mig.routes);ok(mig.ex,'migration adds exclusion keywords');ok(mig.v==='v5.2','version v5.2');
// fresh state
await p.evaluate(async()=>{localStorage.clear();await idbClear()});await p.reload();await p.evaluate(()=>window.appReady);await p.waitForTimeout(300);
ok(await p.evaluate(()=>JSON.stringify(state.settings.marketplaces))==='["US"]','fresh default marketplaces US only');
console.log('syncing');const sync=await p.evaluate(async()=>{const r={};for(const c of state.sheetSyncs)r[c.id]=await runSheetSync(c,true);return r});
console.log(JSON.stringify(sync));
ok(Object.values(sync).every(x=>!x.error),'no sync errors');ok(sync['SYNC-CA'].invalid<=4,'CA spacer rows skipped, invalid now: '+sync['SYNC-CA'].invalid);const cat=await p.evaluate(()=>state.asinCatalog.length);ok(cat>1000,'SKU LIST in catalogue (manual or Monday auto-sync): '+cat);
ok(await p.evaluate(()=>state.asinCatalog.filter(a=>!a.brand).length)===0,'every SKU row has a brand');
ok(await p.evaluate(()=>state.reviews.some(r=>/^R[A-Z0-9]{8,}$/.test(r.reviewId))),'review IDs extracted from links');
const g=await p.evaluate(()=>{const mk=(o)=>{const r={id:nextReviewId(),asin:'B0TESTTEST',brand:'DECOLURE',marketplace:'US',rating:1,title:'t',text:'x',reviewDate:today(),collectedAt:now(),updatedAt:now(),workflow_state:'new',validation:{},approvals:{ab:null,brandManager:null},...o};state.reviews.push(r);analyzeReview(r);return r};
 const out={};
 out.missing=mk({brand:''}).block_reason;
 out.removed=mk({sourceRemoved:true}).block_reason;
 out.protected=mk({asin:'B0FTSVDG77'}).block_reason;
 out.mp=mk({marketplace:'MX',text:'email me at a@b.com'}).block_reason;
 out.canada=mk({marketplace:'CA',text:'email me at a@b.com'}).block_reason;
 out.exclPromo=mk({text:'Just buy it on https://amazon.com/dp/B0X instead.'}).block_reason;
 out.exclPersonal=mk({text:'The seller contacted me at bob@mail.com about a refund.'}).block_reason;
 out.clear=mk({text:'Write to me at bob@mail.com for details.'}).verdict;
 out.product=mk({text:'The fabric feels cheap and it stopped working.'}).verdict;
 const a=mk({reviewId:'R1TESTAAAAAA',text:'Write to me at bob@mail.com for details.'});state.cases.push({id:'CASE-X',reviewId:a.id,status:'closed'});
 out.priorClosed=mk({reviewId:'R1TESTAAAAAA',text:'Write to me at bob@mail.com.'}).block_reason;
 analyzeReview(a);out.selfNotBlocked=a.block_reason||'none';
 state.policies.forEach(x=>x.lastChecked='2020-01-01');out.stale=mk({text:'email bob@mail.com'}).block_reason;
 return out});
console.log(JSON.stringify(g));
ok(g.missing==='MISSING_DATA'&&g.removed==='REVIEW_REMOVED'&&g.protected==='PROTECTED_ASIN'&&g.mp==='NO_MARKETPLACE_MATCH'&&g.stale==='STALE_POLICY','gates 1,2,3,5,6');
ok(g.canada==='CANADA_REVIEWS','Erik 22 Sep: Canadian reviews are never filed');
ok(g.exclPromo!=='EXCLUSION_MATCH'&&g.exclPersonal==='EXCLUSION_MATCH','gate 7 EXCLUSION_MATCH (plain Amazon links are allowed by the guidelines)');
ok(g.priorClosed==='PRIOR_FILING','gate 4 blocks refile after close');ok(g.selfNotBlocked==='none','own case does not self-block');
ok(g.clear==='clear_violation'&&g.product==='not_eligible','classifier verdicts');
ok(await p.evaluate(()=>{const r={title:'',text:'call 555 123 4567'};return postClassifyGates(r,state.policies[0],{evidence:'not in text'})?.reason})==='NO_EVIDENCE_QUOTE','gate 8 NO_EVIDENCE_QUOTE');
// approvals: same person twice rejected; notes hidden
const ap=await p.evaluate(()=>{state.policies.forEach(x=>x.lastChecked=today());const r={id:nextReviewId(),asin:'B0TESTTEST',brand:'DECOLURE',marketplace:'US',rating:1,title:'t',text:'Write to me at bob@mail.com please.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(r);analyzeReview(r);r.validation={at:now()};saveState();openReview(r.id);
 $('#abApproverName').value='Sam';$('#abNotes').value='secret-ab';recordApproval(r,'ab','approve');
 const hidden=!$('#drawerBody').innerHTML.includes('secret-ab');
 $('#bmApproverName').value='sam';recordApproval(r,'brandManager','approve');const blocked=!r.approvals.brandManager;
 $('#bmApproverName').value='Umer Shahid';recordApproval(r,'brandManager','approve');const shown=$('#drawerBody').innerHTML.includes('secret-ab');
 return {hidden,blocked,shown,state:r.workflow_state}});
ok(ap.hidden,'AB notes hidden before BM decides');ok(ap.blocked,'same name for AB and BM refused');ok(ap.shown&&ap.state==='approved','notes shown after both, approved');
// cap uses recorded time, route locked
const cap=await p.evaluate(()=>{state.cases=[];state.settings.weeklyCap=1;const r=state.reviews.at(-1);generateCase(r);const c=state.cases[0];$('#caseSubmitter').value='AB';$('#submittedAt').value='2020-01-01';(fillIds(),markSubmitted)(c);
 const r2={...r,id:nextReviewId(),reviewId:''};state.reviews.push(r2);generateCase(r2);const c2=state.cases.find(x=>x.reviewId===r2.id);$('#caseSubmitter').value='AB';(fillIds(),markSubmitted)(c2);
 return {c1:c.status,route:c.route,ro:$('#caseRoute').readOnly,c2:c2.status}});
ok(cap.c1==='submitted'&&cap.c2==='ready','backdated submission still counts toward weekly cap');ok(cap.route.startsWith('Amazon Brand Registry')&&cap.ro,'case route locked');
// v5.2 alignment: §6.1 approved list, §6.2 priority, §6.3 success rate + auto-pause, §2 follow-up rule
const al=await p.evaluate(()=>{const out={};state.cases=[];state.settings.weeklyCap=99;state.settings.submissionsPaused=false;
 const mk=(o)=>{const r={id:nextReviewId(),asin:'B0TESTTEST',brand:'DECOLURE',marketplace:'US',rating:1,title:'t',text:'Write to me at bob@mail.com please.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null},...o};state.reviews.push(r);analyzeReview(r);return r};
 state.settings.approvedAsins=['B0OTHERASN'];const r=mk({});r.validation={at:now()};r.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(r);out.blockedByList=!caseForReview(r.id);out.nextStep=reviewNextStep(r);
 state.settings.approvedAsins=[];generateCase(r);out.allowedWhenEmpty=Boolean(caseForReview(r.id));
 const old=mk({reviewDate:'2026-06-01',rating:3});out.prioNew=priorityScore(r);out.prioOld=priorityScore(old);out.prioIneligible=priorityScore(mk({text:'The fabric feels cheap.'}));
 const c=caseForReview(r.id);openCase(c.id);$('#caseSubmitter').value='AB';(fillIds(),markSubmitted)(c);out.submitted=c.status;
 openCase(c.id);$('#amazonResponse').value='pending';recordFollowUp(c);out.fuTooSoon=c.followUpCount;
 c.submittedAt=addDays(today(),-22);c.recordedAt=new Date(Date.now()-22*864e5).toISOString();openCase(c.id);$('#amazonResponse').value='declined';recordFollowUp(c);out.fuDeclined=c.followUpCount;
 openCase(c.id);$('#amazonResponse').value='pending';recordFollowUp(c);out.fuAllowed=c.followUpCount;
 openCase(c.id);$('#amazonResponse').value='pending';recordFollowUp(c);out.fuCapped=c.followUpCount;
 openCase(c.id);$('#caseOutcome').value='done';$('#amazonResponse').value='pending';closeCaseRecord(c);out.closeNeedsResponse=c.status;
 openCase(c.id);$('#caseOutcome').value='done';$('#amazonResponse').value='removed';closeCaseRecord(c);out.closed=c.status+'/'+c.amazonResponse;
 out.rate=JSON.stringify(successRate(closedBetween(0,30)));
 // two weeks below 40% -> auto-pause
 const d=n=>new Date(Date.now()-n*86400000).toISOString();
 state.cases.push({id:'W1',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(2),updatedAt:now()},{id:'W1b',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(3),updatedAt:now()},{id:'W2',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(9),updatedAt:now()});
 checkStopConditions();out.pausedPrecision=state.settings.submissionsPaused+' '+state.settings.pauseReason;
 const r2=mk({});r2.validation={at:now()};r2.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(r2);const c2=caseForReview(r2.id);openCase(c2.id);$('#caseSubmitter').value='AB';(fillIds(),markSubmitted)(c2);out.blockedWhilePaused=c2.status;
 // protected breach
 state.settings.submissionsPaused=false;state.cases=state.cases.filter(x=>!x.id.startsWith('W'));state.protectedAsins.push({asin:'B0TESTTEST',parent:'B0TESTTEST',marketplace:'US',status:'active',reason:'test'});checkStopConditions();out.pausedBreach=state.settings.submissionsPaused+' '+state.settings.pauseReason;
 saveState();navigate('settings');out.resumeBtn=Boolean($('#resumeSubmissionsBtn'));navigate('reviews');out.sortSel=Boolean($('#reviewSort'));
 return out});
console.log(JSON.stringify(al));
ok(al.blockedByList&&/approved-for-filing/.test(al.nextStep),'§6.1 approved list blocks unlisted ASIN');ok(al.allowedWhenEmpty,'§6.1 empty list allows all');
ok(al.submitted==='submitted','Mark submitted defaults the date to today');
ok(al.prioNew>al.prioOld&&al.prioIneligible===null,'§6.2 priority ranks recent 1-star above old 3-star');
ok(al.fuTooSoon===0&&al.fuDeclined===0&&al.fuAllowed===1&&al.fuCapped===1,'SOP refile: once, only after 21 days, never after a decline');
ok(al.closeNeedsResponse!=='closed'&&al.closed==='closed/removed','close requires Removed/Declined');
ok(al.rate.includes('"pct":100'),'§6.3 success rate computed');
ok(al.pausedPrecision.startsWith('true Precision below 40%'),'§8 auto-pause on precision two weeks running');ok(al.blockedWhilePaused==='ready','submission blocked while paused');
ok(al.pausedBreach.startsWith('true Protected ASIN breach'),'§8 auto-pause on protected ASIN breach');ok(al.resumeBtn&&al.sortSel,'resume control and priority sort render');

// manual policy added on the Policies page maps reviews by detection keywords (HOLD only)
const mp=await p.evaluate(()=>{state.protectedAsins=state.protectedAsins.filter(x=>x.asin!=='B0TESTTEST');state.policies.forEach(x=>x.lastChecked=today());
 openPolicyForm();const f=$('#policyForm');f.id.value='POL-COUNTERFEIT';f.heading.value='Counterfeit claims without evidence';f.querySelector('input[name="marketplaces"][value="US"]').checked=true;f.keywords.value='counterfeit, fake product';f.guidance.value='Unsupported counterfeit claims';f.exclusions.value='Seller confirmed issue';f.exclusionKeywords.value='seller confirmed';f.url.value='https://www.amazon.com/gp/help/customer/display.html?nodeId=GLHXEX85MENUE4XF';$('#savePolicy').click();
 const pol=policyById('POL-COUNTERFEIT');
 const mk=(t)=>{const r={id:nextReviewId(),asin:'B0TESTTEST',brand:'DECOLURE',marketplace:'US',rating:1,title:'Bad',text:t,reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(r);analyzeReview(r);return r};
 const a=mk('Arrived fine. This is clearly a fake product and I want my money back!');const b=mk('Honestly a counterfeit item, the seller confirmed it.');
 return {saved:Boolean(pol)&&pol.keywords.join('|'),verdict:a.verdict,policy:a.classification?.policyId,evidence:a.classification?.evidence,excl:b.block_reason}});
console.log(JSON.stringify(mp));
ok(mp.saved==='counterfeit|fake product','manual policy saved with detection keywords');
ok(mp.verdict==='hold'&&mp.policy==='POL-COUNTERFEIT'&&mp.evidence==='This is clearly a fake product and I want my money back','manual policy maps review to HOLD with verbatim evidence');
ok(mp.excl==='EXCLUSION_MATCH','manual policy exclusion keywords block');

// false positives found on the live Master File (21 Sep) must stay NOT ELIGIBLE; fulfilment errors go to HOLD
const fp=await p.evaluate(()=>{const v=(rating,text)=>classifyReview({rating,title:'',text,marketplace:'US'});
 return {buyAgain:v(5,'I would buy from this brand again in a heart beat.').verdict,
  wontBuy:v(3,"Won't buy from them again. The sheet was thin.").verdict,
  insertCard:v(2,'The discount code card inside the box did not work on Amazon.').verdict,
  date:v(1,'Order received 2025-12-19 and it ripped.').verdict,
  orderId:v(1,'My order number is 112-3456789-1234567.').verdict,
  realPhone:v(1,'Call me on 416-555-0199 about this.').verdict,
  realCode:v(1,'Use code SAVE20 at my shop instead.').verdict,
  wrongSize:v(2,'Wrong size sent. I ordered Full and got King.').verdict,
  words:wordCount(caseDraft({asin:'B0X',marketplace:'US',reviewId:'R1ABCDEFGH',sourceRef:'https://www.amazon.com/gp/customer-reviews/R1ABCDEFGH',classification:{evidence:'Wrong size sent'}},state.policies.find(x=>x.id==='POL-SELLER')))}});
console.log(JSON.stringify(fp));
ok(fp.buyAgain==='not_eligible'&&fp.wontBuy==='not_eligible','"buy from them again" is not promotional content');
ok(fp.insertCard==='not_eligible','mention of our own discount card is not promotional content');
ok(fp.date==='not_eligible'&&fp.orderId==='clear_violation','dates are not phone numbers; order numbers are Private information (Community Guidelines)');
ok(fp.realPhone!=='not_eligible'&&fp.realCode!=='not_eligible','real phone numbers and codes still detected');
ok(fp.wrongSize==='clear_violation','order-only wrong item sent → CLEAR (seller and order feedback)');ok(fp.words<=150,'improved case draft stays within 150 words: '+fp.words);

// Community Guidelines "What's not allowed" register (15 policies) — verbatim wording, sub-bullets, safeguards, mixed content
const cg=await p.evaluate(()=>{state.policies.forEach(x=>x.lastChecked=today());state.settings.marketplaces=['US','CA','MX','BR'];
 const run=(rating,text,mp='US')=>{const c=classifyReview({id:'X'+Math.round(Math.abs(text.length*rating)),asin:'B0CG',rating,title:'',text,marketplace:mp});return c.verdict+':'+(c.policyId||'-')+(c.bullet?'|'+c.bullet:'')};
 const draftFor=(text,rating=1,mp='US')=>{const r={id:'D',asin:'B0X',marketplace:mp,reviewId:'R1ABCDEFGH',rating,title:'',text};const c=classifyReview(r);r.classification=c;return c.policyId?caseDraft(r,policyById(c.policyId)):''};
 const d1=draftFor('Item never arrived.');const d2=draftFor('The box was crushed.');
 return {count:state.policies.filter(x=>BUILTIN_POLICY_IDS.includes(x.id)).length,
  retiredInactive:state.policies.filter(x=>RETIRED_POLICY_IDS[x.id]).every(x=>x.status==='inactive'),
  profanity:run(1,'These are shit.'),
  nameCalling:run(1,'The staff are idiots.'),
  defamation:run(1,'This company is a scam.'),
  defamationMixed:run(1,'This company is a scam. The fabric is thin.'),
  compensated:run(2,'I received these for free in exchange for an honest review.'),
  sellerAskedChange:run(1,'The seller offered me a refund if I changed my review.'),
  refundAfterReview:run(1,'Customer service was terrible. After they read my review they sent a refund.'),
  willUpdate:run(1,'Item never arrived. I will update my review later.'),
  coi:run(1,'I work for a competitor and these are worse.'),
  pricingElsewhere:run(2,'Found this item here for $5 less than at my local store.'),
  pricingValue:run(2,'Not worth the price at all.'),
  comparison:run(2,'Other brands are much better. The fabric pilled.'),
  walmart:run(1,'I have had better sheet sets from Walmart and Target.'),
  amazonLink:run(1,'See https://www.amazon.com/dp/B0ABC instead.'),
  affiliate:run(1,'Buy here https://www.amazon.com/dp/B0ABC?tag=deals-20 instead.'),
  externalLink:run(1,'Go to www.bettersheets.com for real sheets.'),
  orderNumber:run(1,'Here is my order 112-3456789-1234567.'),
  french:run(1,"Les draps sont très minces et la qualité est mauvaise pour le prix, je ne les recommande pas du tout à personne.",'US'),
  frenchCA:run(1,"Les draps sont très minces et la qualité est mauvaise pour le prix, je ne les recommande pas du tout à personne.",'CA'),
  spanishUS:run(1,'Las sábanas son muy delgadas y la calidad es mala para el precio, no las recomiendo para nada.','US'),
  gibberish:run(1,'asdfghjk qwrtpsdfg zxcvbnm'),
  repetitiveSym:run(1,'!!!!!!!!!!!!'),
  shortOk:run(3,'It’s ok.'),
  medical:run(2,'These sheets cured my eczema.'),
  medicalMixed:run(2,'These sheets cured my eczema but they pill.'),
  notDelivered:run(1,'Item never arrived.'),
  orderOnly:run(1,'The box was crushed.'),
  orderMixed:run(2,'Two pillow cases had a large tear and there is no way to contact the company.'),
  missing:run(2,'Missing pieces, only received two pillow cases.'),
  d1,d2,d1w:wordCount(d1),d2w:wordCount(d2)}});
console.log(JSON.stringify(cg));
ok(cg.count===15&&cg.retiredInactive,'15 Community Guidelines policies; retired v5.1 categories inactive');
ok(cg.profanity==='clear_violation:POL-PROFANITY|Profanity, obscenities, or name-calling','profanity → CLEAR with exact sub-bullet');
ok(cg.nameCalling.startsWith('hold:POL-PROFANITY')||cg.nameCalling.startsWith('clear_violation:POL-PROFANITY')?cg.nameCalling.startsWith('hold'):false,'name-calling → HOLD');
ok(cg.defamation==='hold:POL-PROFANITY|Libel, defamation, or inflammatory content'&&cg.defamationMixed.startsWith('not_eligible'),'scam accusation → Tier 2; with any product complaint → Tier 3 (SOP purity)');
ok(cg.compensated==='clear_violation:POL-COMPENSATED','compensated review → CLEAR');
ok(cg.sellerAskedChange.startsWith('not_eligible')&&cg.refundAfterReview.startsWith('not_eligible'),'SAFEGUARD: reviews mentioning our refund/offer in connection with a review are never flagged');
ok(cg.willUpdate.startsWith('clear_violation:POL-SELLER'),'"I will update my review" does not trip the safeguard');
ok(cg.coi==='clear_violation:POL-PROMO','conflict of interest (competitor) → CLEAR');
ok(cg.pricingElsewhere.startsWith('clear_violation:POL-PRICING')&&cg.pricingValue.startsWith('not_eligible'),"Amazon's own pricing example flagged, value comment not");
ok(cg.comparison.startsWith('not_eligible')&&cg.walmart.startsWith('not_eligible'),'competitor comparisons are NOT flagged (Seller Central: not removable)');
ok(cg.amazonLink.startsWith('not_eligible')&&cg.affiliate==='clear_violation:POL-LINKS'&&cg.externalLink==='clear_violation:POL-LINKS','Amazon link allowed; affiliate tag and external site flagged');
ok(cg.orderNumber==='clear_violation:POL-PERSONAL|Order number','order number → Private information');
ok(cg.french.startsWith('clear_violation:POL-LANGUAGE|French')&&cg.frenchCA.startsWith('not_eligible')&&cg.spanishUS.startsWith('not_eligible'),'French on Amazon.com flagged; French on CA and Spanish on US allowed');
ok(cg.gibberish==='clear_violation:POL-REPETITIVE|Nonsense and gibberish'&&cg.repetitiveSym.startsWith('clear_violation:POL-REPETITIVE')&&cg.shortOk.startsWith('not_eligible'),'gibberish and symbol spam flagged; short genuine review not');
ok(cg.medical.startsWith('hold:POL-MEDICAL')&&cg.medicalMixed.startsWith('not_eligible'),'medical claim → Tier 2; with a product complaint → Tier 3');
ok(cg.notDelivered==='clear_violation:POL-SELLER|Ordering issues and returns','never received → Tier 1, Ordering issues and returns (SOP: lost or never delivered)');
ok(cg.orderOnly==='clear_violation:POL-SELLER|Shipping packaging'&&cg.orderMixed.startsWith('not_eligible')&&cg.missing==='clear_violation:POL-SELLER|Ordering issues and returns','order-only Tier 1 with sub-bullet; any product complaint → Tier 3 (SOP purity gate)');
ok(/Guideline section: Seller, order, or shipping feedback/.test(cg.d1)&&/The review states in full: "Item never arrived\."/.test(cg.d1)&&/The content concerns an ordering issue rather than the product\. Amazon's Community Guidelines list "Ordering issues and returns" under Seller, order, or shipping feedback/.test(cg.d1)&&/We request removal of this review under the cited guideline\.$/.test(cg.d1),'SOP five-part filing: section, quote in full, tie, request');
ok(/list "Shipping packaging" under Seller, order, or shipping feedback/.test(cg.d2)&&!/Seller Central policy:|Community Guidelines: https/.test(cg.d2)&&/Review URL: |Order ID: /.test(cg.d2),'draft ties the quote to the exact sub-bullet; identifiers present; no extra parts (SOP section 8)');
ok(cg.d1w<=150&&cg.d2w<=150,'drafts ≤150 words: '+cg.d1w+' / '+cg.d2w);

// Calibration from the independent review (21 Sep): only-focus, listing mismatch, curly apostrophes, off-Amazon safeguard
const cal=await p.evaluate(()=>{const run=(rating,text,mp='US')=>{const c=classifyReview({id:'C'+text.length,asin:'B0CAL',rating,title:'',text,marketplace:mp});return c.verdict+':'+(c.policyId||'-')};
 return {
  curly:run(1,'I couldn’t even open the box. But decided I didn’t need it'),
  onlyFocusDowngrade:run(2,'Wrong size sent. The fabric is soft and the stitching is great.'),
  listing:run(2,'What we received was grey. Not like the pictures at all.'),
  offAmazon:run(1,'Item never arrived. When emailing with the company they did nothing.'),
  contactOnBox:run(1,'No phone number or email listed on the box so there is no way to contact the seller.'),
  usedItem:run(1,'Used item came to me'),
  emptyBoxFr:run(1,"J'ai reçu une boîte vide ? Je veux mes draps.",'CA'),
  localWalmart:run(2,'These are great sheets but not at these prices, go to your local Walmart.'),
  saleValue:run(3,'I purchased a king set on sale for $55. Too much maintenance.'),
  functionRemark:run(2,'Was missing parts. The chair does not function flawlessly due to this.'),
  lateDays:run(2,'Arrived six days late.'),
  medicalQuote:policyById('POL-MEDICAL').caseStatement,
  hateQuote:policyById('POL-HATE').caseStatement}});
console.log(JSON.stringify(cal));
ok(cal.curly==='clear_violation:POL-SELLER','curly apostrophes are matched (evidence stays verbatim)');
ok(cal.onlyFocusDowngrade.startsWith('not_eligible'),'order complaint that also assesses the product → NOT ELIGIBLE (Amazon: "only focus")');
ok(cal.listing.startsWith('not_eligible'),'colour vs listing photos is product feedback, not an ordering issue');
ok(cal.offAmazon.startsWith('not_eligible')&&cal.contactOnBox.startsWith('not_eligible'),'SAFEGUARD 2: contact outside Amazon / contact details on packaging → never report');
ok(cal.usedItem==='clear_violation:POL-SELLER'&&cal.emptyBoxFr==='clear_violation:POL-SELLER','used item and empty box (French) → CLEAR');
ok(cal.localWalmart==='hold:POL-PRICING'&&cal.saleValue.startsWith('not_eligible'),'"go to your local Walmart" flagged; personal sale price is a value comment');
ok(cal.functionRemark.startsWith('not_eligible'),'missing parts plus a product remark → Tier 3 (SOP purity gate)');
ok(cal.lateDays==='clear_violation:POL-SELLER','"arrived six days late" → Shipping cost and speed');
ok(!/This policy applies to all products\."/.test(cal.medicalQuote)&&/"We don't allow any statements or claims related to preventing or curing serious medical conditions or severe symptoms\."/.test(cal.medicalQuote),'Medical claims quote is verbatim');
ok(/characteristics like:" race, ethnicity/.test(cal.hateQuote),'Hate speech quote keeps Amazon wording inside quotes only');
// Drawer clarity + full-history scan + end-to-end case from a scanned candidate
const ux=await p.evaluate(async()=>{
 state.reviews=[];state.cases=[];state.protectedAsins=state.protectedAsins.filter(x=>x.asin!=='B0TESTTEST');state.settings.marketplaces=['US','CA'];state.settings.submissionsPaused=false;state.settings.approvedAsins=[];state.policies.forEach(x=>x.lastChecked=today());
 const ne={id:nextReviewId(),asin:'B0NE',brand:'DECOLURE',marketplace:'US',rating:2,title:'Bad quality',text:"Quality is poor and it didn't fit correctly.",reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};
 state.reviews.push(ne);analyzeReview(ne);saveState();openReview(ne.id);
 const neBody=$('#drawerBody').innerHTML,neFoot=$('#drawerFooter').innerHTML;closeDrawer();
 const res=await scanFullHistory(true);
 const kept=state.reviews.filter(r=>r.id!==ne.id);
 const cand=kept.find(r=>r.verdict==='clear_violation');
 openReview(cand.id);const cBody=$('#drawerBody').innerHTML;
 ['vSource','vQuote','vPolicy','vProduct','vExclusion'].forEach(id=>$('#'+id).checked=true);$('#validatorName').value='AB';saveValidation(cand);
 openReview(cand.id);$('#abApproverName').value='AB';recordApproval(cand,'ab','approve');
 openReview(cand.id);$('#bmApproverName').value='Umer Shahid';recordApproval(cand,'brandManager','approve');
 generateCase(cand);const cs=caseForReview(cand.id);
 return {neHasPanel:/This review cannot become a removal case/.test(neBody),neNoChecklist:!/id="vSource"/.test(neBody),neFootOnlyRerun:!/generateCase|saveValidation/.test(neFoot),
  res,keptAllCandidates:kept.every(isCaseCandidate),keptCount:kept.length,noAuditBloat:state.auditLog.length<500,
  candHasChecklist:/id="vSource"/.test(cBody),caseStatus:cs?.status,draftBasis:/Guideline section: /.test(cs?.draft||'')&&/We request removal of this review under the cited guideline\./.test(cs?.draft||''),draftWords:wordCount(cs?.draft||'')}});
console.log(JSON.stringify(ux));
ok(ux.neHasPanel&&ux.neNoChecklist&&ux.neFootOnlyRerun,'NOT ELIGIBLE review: explains why, hides checklist/approvals, footer only offers Re-run');
ok(ux.res&&ux.res.scanned>700&&ux.res.kept>=3&&ux.keptAllCandidates&&ux.keptCount===ux.res.kept,'full-history scan checks all negative reviews and keeps only candidates: '+JSON.stringify(ux.res));
ok(ux.noAuditBloat,'scan does not flood the audit log with discarded reviews');
ok(ux.candHasChecklist&&ux.caseStatus==='ready'&&ux.draftBasis&&ux.draftWords<=150,'scanned candidate → validation → AB + BM approval → case ready with guideline-based draft');

// Validator aids: title/body kept separate in evidence, Find on Amazon link, rule shown on the review
const va=await p.evaluate(()=>{state.settings.marketplaces=['US','CA'];state.canadaAsins=(state.canadaAsins||[]).filter(x=>x!=='B0DDTXFRNB');state.policies.forEach(x=>x.lastChecked=today());
 const r={id:nextReviewId(),asin:'B0DDTXFRNB',brand:'DECOLURE',marketplace:'US',rating:1,title:'Dissatisfied',text:'Missing a pillow case from the order. 4 pictured received 3.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};
 state.reviews.push(r);analyzeReview(r);saveState();openReview(r.id);const body=$('#drawerBody').innerHTML;closeDrawer();
 return {verdict:r.verdict,evidence:r.classification?.evidence,find:/product-reviews\/B0DDTXFRNB\/\?sortBy=recent&amp;filterByStar=one_star/.test(body),rule:/Rule it breaks:<\/b> The content concerns an ordering issue rather than the product\. Amazon's Community Guidelines list "Ordering issues and returns" under Seller, order, or shipping feedback/.test(body.replace(/&quot;/g,'"').replace(/&#39;/g,"'")),links:/Seller Central policy ↗/.test(body)}});
console.log(JSON.stringify(va));
ok(va.verdict==='clear_violation'&&va.evidence==='Missing a pillow case from the order','evidence is the exact sentence (title not merged into the quote)');
ok(va.find,'"Find on Amazon" opens the product reviews filtered to the review\'s star rating');
ok(va.rule&&va.links,'review screen shows Amazon\'s exact rule and the policy links for the validator');

// Review queue filters: rating and product; lowest-rating sort
const fl=await p.evaluate(()=>{state.reviews=[];state.asinCatalog.push({brand:'DECOLURE',parent:'B0PARENT01',child:'B0CHILD001',sku:'X',marketplace:'US',productName:'DECOLURE BAMBOO SHEET 4PCS'});
 const add=(asin,rating,text)=>{const r={id:nextReviewId(),asin,brand:'DECOLURE',marketplace:'US',rating,title:'t',text,reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(r);analyzeReview(r)};
 add('B0CHILD001',1,'Stopped working fast.');add('B0CHILD001',5,'Great.');add('B0CHILD001',2,'Thin fabric.');add('B0UNKNOWN1',3,'Okay.');saveState();navigate('reviews');
 const rows=()=>$$('#reviewTableBody tr').length;
 const all=rows();
 $('#reviewRatingFilter').value='neg';renderReviews();const neg=rows();
 $('#reviewRatingFilter').value='5';renderReviews();const five=rows();
 $('#reviewRatingFilter').value='all';$('#reviewProductFilter').value='DECOLURE BAMBOO SHEET 4PCS';renderReviews();const prod=rows();
 const opts=[...$('#reviewProductFilter').options].map(o=>o.textContent);
 $('#reviewProductFilter').value='all';$('#reviewSort').value='rating';renderReviews();
 const firstRating=$('#reviewTableBody tr .rating')?.textContent;
 const showsProduct=$('#reviewTableBody').innerHTML.includes('DECOLURE BAMBOO SHEET 4PCS');
 $('#reviewSort').value='priority';renderReviews();
 return {all,neg,five,prod,opts,firstRating,showsProduct}});
console.log(JSON.stringify(fl));
ok(fl.all===4&&fl.neg===3&&fl.five===1,'rating filter: all / 1–3★ / exact star');
ok(fl.prod===3&&fl.opts.some(o=>o.startsWith('DECOLURE BAMBOO SHEET 4PCS (3)'))&&fl.opts.some(o=>o.startsWith('Unmapped ASIN')),'product filter lists catalogue products with counts and filters rows');
ok(fl.firstRating&&fl.firstRating.startsWith('1')&&fl.showsProduct,'lowest-rating sort; product name shown under the ASIN');

// SOP v1.0 alignment (22 Sep): wrong product Tier 2, refund-from-us disqualifier, Canada family exclusion, cadence, control set, trends
const sop=await p.evaluate(()=>{state.policies.forEach(x=>x.lastChecked=today());state.settings.marketplaces=['US','CA'];state.settings.submissionsPaused=false;state.settings.weeklyCap=99;state.settings.approvedAsins=[];
 state.asinCatalog.push({brand:'DECOLURE',parent:'B0WPPARENT',child:'B0WPCHILD1',sku:'X',marketplace:'US',productName:'DECOLURE SATIN FITTED SHEET 1PC'});
 const run=(asin,rating,title,text)=>{const c=classifyReview({id:'S'+text.length,asin,rating,title,text,marketplace:'US'});return c.verdict+':'+(c.policyId||'-')};
 const wrong=run('B0WPCHILD1',1,'The BED IS MORE GARBAGE','Needs at least 2 people to assemble. The plastic thingies to snap into the bedframes are fragile and consistently break. One side of the bed the planks have fallen out.');
 const refunded=run('B0X',1,'','Never arrived. The seller refunded me.');
 const langMixed=run('B0X',1,'','The sheets are very soft and I love them. Les draps sont très doux et la qualité est bonne pour le prix.');
 // Canada family: a US review on a child whose parent has Canadian reviews
 state.canadaAsins=[...(state.canadaAsins||[]),'B0WPPARENT'];
 const r={id:nextReviewId(),asin:'B0WPCHILD1',parent:'',brand:'DECOLURE',marketplace:'US',rating:1,title:'Missing',text:'Missing a pillow case from the order.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(r);analyzeReview(r);
 const canadaFamily=r.block_reason;
 state.canadaAsins=state.canadaAsins.filter(x=>x!=='B0WPPARENT');analyzeReview(r);const afterRemoval=r.verdict;
 // cadence: two Tier 1 cases on the same ASIN inside 48 hours
 state.cases=[];const mkc=()=>{const x={id:nextReviewId(),asin:'B0CADENCE1',brand:'DECOLURE',marketplace:'US',rating:1,title:'Missing',text:'Missing a pillow case from the order '+Math.random(),reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{at:now()},approvals:{ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}}};state.reviews.push(x);analyzeReview(x);x.validation={at:now()};x.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(x);const c=caseForReview(x.id);openCase(c.id);$('#caseSubmitter').value='AB';(fillIds(),markSubmitted)(c);return c.status};
 const first=mkc(),second=mkc();
 // tier 2 not filed in phase 1
 const h={id:nextReviewId(),asin:'B0TIER2XX1',brand:'DECOLURE',marketplace:'US',rating:1,title:'t',text:'This company is a scam.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(h);analyzeReview(h);h.validation={at:now()};h.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(h);const hc=caseForReview(h.id);
 // control set + learning card
 const t1={id:nextReviewId(),asin:'B0CONTROL1',brand:'DECOLURE',marketplace:'US',rating:1,title:'Used',text:'Used item came to me',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(t1);analyzeReview(t1);
 setControl(t1,true);markRemovedOnAmazon(t1);saveState();navigate('dashboard');
 const card=$('#learningCard')?.innerHTML||'';
 return {wrong,refunded,langMixed,canadaFamily,afterRemoval,first,second,tier2:hc?hc.status:'no case',controlRate:/Control-set removal rate<\/span><b>100%/.test(card),card:!!card,tierRate:/SOP expects 4–8%/.test(card)}});
console.log(JSON.stringify(sop));
ok(sop.wrong==='hold:POL-WRONGPRODUCT','review of a different product (bed frame on a fitted sheet) → Tier 2 (SOP Example 3)');
ok(sop.refunded.startsWith('not_eligible'),'SOP disqualifier: refund or replacement from us → never file');
ok(sop.langMixed==='clear_violation:POL-LANGUAGE','mixed-language review → Tier 1 (SOP)');
ok(sop.canadaFamily==='CANADA_REVIEWS'&&sop.afterRemoval==='clear_violation','Canada exclusion covers the whole parent family; lifts when the family has no Canadian reviews');
ok(sop.first==='submitted'&&sop.second==='ready','SOP spacing: a second filing on the same ASIN inside 48 hours is blocked');
ok(sop.tier2==='no case','SOP Phase 1: no case can be generated for a Tier 2 review');
ok(sop.card&&sop.controlRate&&sop.tierRate,'Learning and trends card: control-set removal rate and Tier 1 rate vs SOP 4–8%');
// MajestIQ conditions from SOP 4.3 not previously detected: steering to a competing brand, threats
const mq=await p.evaluate(()=>{const run=(text)=>{const c=classifyReview({id:'M'+text.length,asin:'B0MQ',rating:1,title:'',text,marketplace:'US'});return c.verdict+':'+(c.policyId||'-')};
 return {steer:run('Buy the Utopia brand instead.'),comparison:run('Other brands are much better.'),threat:run('You will regret this, I will find you.'),sue:run('I will sue.')}});
console.log(JSON.stringify(mq));
ok(mq.steer==='hold:POL-PROMO'&&mq.comparison.startsWith('not_eligible'),'explicit steering to a competing brand → Tier 2; plain comparison → Tier 3');
ok(mq.threat==='hold:POL-PROFANITY'&&mq.sue.startsWith('not_eligible'),'threat → Tier 2 (Harassment or threats); "I will sue" is not a threat');
// QA round 1 (22 Sep): storage beyond 5 MB, approval flow, rating-first, routing labels
const qa1=await p.evaluate(async()=>{state.policies.forEach(x=>x.lastChecked=today());state.settings.marketplaces=['US','CA'];
 // 1. store well over 5 MB and read it back
 const big='x'.repeat(2000);const extra=[];for(let i=0;i<4000;i++)extra.push({id:'BIG'+i,asin:'B0BIG',brand:'DECOLURE',marketplace:'US',rating:5,title:'t',text:big,reviewDate:today(),updatedAt:now()});
 state.reviews.push(...extra);saveState();await saveChain;const back=await idbGet();const bigOk=back.reviews.length>=4000&&JSON.stringify(back).length>7000000&&!saveError;
 state.reviews=state.reviews.filter(r=>!r.id.startsWith('BIG'));saveState();await saveChain;
 // 2. 5★ review is "not a target", never blocked
 const five={id:nextReviewId(),asin:'B0CA5STAR',brand:'DECOLURE',marketplace:'CA',rating:5,title:'Great',text:'Love them.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(five);analyzeReview(five);
 // 3. approval before validation is saved: buttons disabled; ticking the checklist then approving auto-saves validation
 const r={id:nextReviewId(),asin:'B0APPROVE1',brand:'DECOLURE',marketplace:'US',rating:1,title:'Missing',text:'Missing a pillow case from the order.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null}};
 state.canadaAsins=(state.canadaAsins||[]).filter(x=>x!=='B0APPROVE1');state.reviews.push(r);analyzeReview(r);saveState();openReview(r.id);
 let lastToast='';const _t=toast;toast=m=>{lastToast=m;_t(m)};recordApproval(r,'ab','approve');const disabledBefore=!r.approvals?.ab&&!r.validation?.at&&/Finish Human validation first/.test(lastToast);toast=_t;openReview(r.id);
 ['vSource','vQuote','vPolicy','vProduct','vExclusion'].forEach(id=>$('#'+id).checked=true);$('#validatorName').value='AB';
 recordApproval(r,'ab','approve');const abAfter=r.approvals.ab?.decision,valSaved=!!r.validation.at;
 openReview(r.id);const enabledAfter=!$('#approveBM').disabled;$('#bmApproverName').value='Umer Shahid';recordApproval(r,'brandManager','approve');
 return {bigOk,five:five.workflow_state+'|'+five.verdict+'|'+customerRoute(five).label,disabledBefore,abAfter,valSaved,enabledAfter,state:r.workflow_state,route:customerRoute(r).label}});
console.log(JSON.stringify(qa1));
ok(qa1.bigOk,'browser database holds more than 7 MB (the old 5 MB limit is gone)');
ok(qa1.five==='routed|not_eligible|Positive review · no action','4–5★ review is "Positive review · no action", never blocked (SOP Gate 1)');
ok(qa1.disabledBefore&&qa1.abAfter==='approve'&&qa1.valSaved&&qa1.enabledAfter&&qa1.state==='approved','Approve with an incomplete checklist records nothing and says what is missing; a completed checklist is saved automatically on approve');
ok(qa1.route==='Tier 1 · removal case','routing label uses Tier wording');
// real clicks: typing the validator name then clicking Save validation must save (the footer is not redrawn under the click)
{const rid=await p.evaluate(()=>{const r={id:nextReviewId(),reviewId:'RCLICK001',asin:'B0CLICK001',brand:'DECOLURE',marketplace:'US',rating:1,title:'Contact',text:'Write to me at click.test@example.com please.',reviewDate:today(),collectedAt:now(),workflow_state:'new',verdict:'',classification:null,validation:{},approvals:{ab:null,brandManager:null}};state.reviews.push(r);analyzeReview(r,'user');saveState();navigate('reviews');openReview(r.id);return r.id});
 for(const x of ['vSource','vQuote','vPolicy','vProduct','vExclusion'])await p.check('#'+x);
 await p.fill('#validatorName','Click Tester');await p.click('#saveValidation');await p.waitForTimeout(200);
 ok(await p.evaluate(id=>!!state.reviews.find(x=>x.id===id).validation?.at,rid),'typing the validator name then clicking Save validation saves it (click not lost)');
 await p.evaluate(()=>closeDrawer&&closeDrawer())}
ok(errs.length===0,'no page errors '+errs.join('|'));
console.log(`\n${pass} passed, ${fail} failed`);await b.close();srv.close()})();
