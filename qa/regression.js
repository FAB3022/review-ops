// Regression checks for index.html (v5.2, aligned to Final Proposal v2.2). Run: npm i playwright-core && node qa/regression.js index.html
// Uses local Chrome and pulls the live Master File tabs for the sync checks.
const {chromium}=require('playwright-core');const http=require('http'),fs=require('fs');
const html=fs.readFileSync(process.argv[2]);
const srv=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(html)}).listen(8767);
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const p=await b.newPage();const errs=[];p.on('dialog',d=>d.accept('Erik'));p.setDefaultTimeout(60000);p.on('pageerror',e=>errs.push(e.message));
// migration from a v5.0 browser state
await p.goto('http://localhost:8767/');await p.evaluate(()=>{const s=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')||state;s.policies.forEach(x=>{x.route='Seller Central > Help > Report abuse';delete x.exclusionKeywords});s.settings.scriptVersion='v5.0';localStorage.setItem(STORAGE_KEY,JSON.stringify(s))});
await p.reload();await p.waitForTimeout(800);
const mig=await p.evaluate(()=>({routes:[...new Set(state.policies.map(x=>x.route))],ex:state.policies.every(x=>Array.isArray(x.exclusionKeywords)),v:state.settings.scriptVersion}));
ok(mig.routes.length===1&&mig.routes[0].startsWith('Amazon Brand Registry'),'migration locks route: '+mig.routes);ok(mig.ex,'migration adds exclusion keywords');ok(mig.v==='v5.2','version v5.2');
// fresh state
await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForTimeout(800);
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
 out.mp=mk({marketplace:'CA',text:'email me at a@b.com'}).block_reason;
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
ok(g.exclPromo==='EXCLUSION_MATCH'&&g.exclPersonal==='EXCLUSION_MATCH','gate 7 EXCLUSION_MATCH');
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
const cap=await p.evaluate(()=>{state.cases=[];state.settings.weeklyCap=1;const r=state.reviews.at(-1);generateCase(r);const c=state.cases[0];$('#caseSubmitter').value='AB';$('#submittedAt').value='2020-01-01';markSubmitted(c);
 const r2={...r,id:nextReviewId(),reviewId:''};state.reviews.push(r2);generateCase(r2);const c2=state.cases.find(x=>x.reviewId===r2.id);$('#caseSubmitter').value='AB';markSubmitted(c2);
 return {c1:c.status,route:c.route,ro:$('#caseRoute').readOnly,c2:c2.status}});
ok(cap.c1==='submitted'&&cap.c2==='ready','backdated submission still counts toward weekly cap');ok(cap.route.startsWith('Amazon Brand Registry')&&cap.ro,'case route locked');
// v5.2 alignment: §6.1 approved list, §6.2 priority, §6.3 success rate + auto-pause, §2 follow-up rule
const al=await p.evaluate(()=>{const out={};state.cases=[];state.settings.weeklyCap=99;state.settings.submissionsPaused=false;
 const mk=(o)=>{const r={id:nextReviewId(),asin:'B0TESTTEST',brand:'DECOLURE',marketplace:'US',rating:1,title:'t',text:'Write to me at bob@mail.com please.',reviewDate:today(),collectedAt:now(),updatedAt:now(),validation:{},approvals:{ab:null,brandManager:null},...o};state.reviews.push(r);analyzeReview(r);return r};
 state.settings.approvedAsins=['B0OTHERASN'];const r=mk({});r.validation={at:now()};r.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(r);out.blockedByList=!caseForReview(r.id);out.nextStep=reviewNextStep(r);
 state.settings.approvedAsins=[];generateCase(r);out.allowedWhenEmpty=Boolean(caseForReview(r.id));
 const old=mk({reviewDate:'2026-06-01',rating:3});out.prioNew=priorityScore(r);out.prioOld=priorityScore(old);out.prioIneligible=priorityScore(mk({text:'The fabric feels cheap.'}));
 const c=caseForReview(r.id);openCase(c.id);$('#caseSubmitter').value='AB';markSubmitted(c);out.submitted=c.status;
 openCase(c.id);$('#amazonResponse').value='declined';recordFollowUp(c);out.fu1=c.followUpCount;
 state.settings.followUpMax=2;openCase(c.id);$('#amazonResponse').value='declined';recordFollowUp(c);out.fu2blocked=c.followUpCount;
 openCase(c.id);$('#amazonResponse').value='insufficient_info';recordFollowUp(c);out.fu2allowed=c.followUpCount;
 openCase(c.id);$('#caseOutcome').value='done';$('#amazonResponse').value='pending';closeCaseRecord(c);out.closeNeedsResponse=c.status;
 openCase(c.id);$('#caseOutcome').value='done';$('#amazonResponse').value='removed';closeCaseRecord(c);out.closed=c.status+'/'+c.amazonResponse;
 out.rate=JSON.stringify(successRate(closedBetween(0,30)));
 // two weeks below 40% -> auto-pause
 const d=n=>new Date(Date.now()-n*86400000).toISOString();
 state.cases.push({id:'W1',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(2),updatedAt:now()},{id:'W1b',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(3),updatedAt:now()},{id:'W2',reviewId:r.id,status:'closed',amazonResponse:'declined',closedAt:d(9),updatedAt:now()});
 checkStopConditions();out.pausedPrecision=state.settings.submissionsPaused+' '+state.settings.pauseReason;
 const r2=mk({});r2.validation={at:now()};r2.approvals={ab:{by:'A',decision:'approve'},brandManager:{by:'B',decision:'approve'}};generateCase(r2);const c2=caseForReview(r2.id);openCase(c2.id);$('#caseSubmitter').value='AB';markSubmitted(c2);out.blockedWhilePaused=c2.status;
 // protected breach
 state.settings.submissionsPaused=false;state.cases=state.cases.filter(x=>!x.id.startsWith('W'));state.protectedAsins.push({asin:'B0TESTTEST',parent:'B0TESTTEST',marketplace:'US',status:'active',reason:'test'});checkStopConditions();out.pausedBreach=state.settings.submissionsPaused+' '+state.settings.pauseReason;
 saveState();navigate('settings');out.resumeBtn=Boolean($('#resumeSubmissionsBtn'));navigate('reviews');out.sortSel=Boolean($('#reviewSort'));
 return out});
console.log(JSON.stringify(al));
ok(al.blockedByList&&/approved-for-filing/.test(al.nextStep),'§6.1 approved list blocks unlisted ASIN');ok(al.allowedWhenEmpty,'§6.1 empty list allows all');
ok(al.submitted==='submitted','Mark submitted defaults the date to today');
ok(al.prioNew>al.prioOld&&al.prioIneligible===null,'§6.2 priority ranks recent 1-star above old 3-star');
ok(al.fu1===1&&al.fu2blocked===1&&al.fu2allowed===2,'§2 second follow-up only after insufficient-info');
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
  orderId:v(1,'Order 112-3456789-1234567 ripped after one wash.').verdict,
  realPhone:v(1,'Call me on 416-555-0199 about this.').verdict,
  realCode:v(1,'Use code SAVE20 at my shop instead.').verdict,
  wrongSize:v(2,'Wrong size sent. I ordered Full and got King.').verdict,
  words:wordCount(caseDraft({asin:'B0X',marketplace:'US',reviewId:'R1ABCDEFGH',sourceRef:'https://www.amazon.com/gp/customer-reviews/R1ABCDEFGH',classification:{evidence:'Wrong size sent'}},state.policies.find(x=>x.id==='POL-SELLER')))}});
console.log(JSON.stringify(fp));
ok(fp.buyAgain==='not_eligible'&&fp.wontBuy==='not_eligible','"buy from them again" is not promotional content');
ok(fp.insertCard==='not_eligible','mention of our own discount card is not promotional content');
ok(fp.date==='not_eligible'&&fp.orderId==='not_eligible','dates and order numbers are not phone numbers');
ok(fp.realPhone!=='not_eligible'&&fp.realCode!=='not_eligible','real phone numbers and codes still detected');
ok(fp.wrongSize==='clear_violation','order-only wrong item sent → CLEAR (seller and order feedback)');ok(fp.words<=150,'improved case draft stays within 150 words: '+fp.words);

// Community Guidelines categories (8 policies) — positives, safeguards and mixed-content handling
const cg=await p.evaluate(()=>{state.policies.forEach(x=>x.lastChecked=today());const v=(rating,text)=>{const c=classifyReview({id:'X',asin:'B0CG',rating,title:'',text,marketplace:'US'});return c.verdict+':'+(c.policyId||'-')};
 return {count:state.policies.filter(x=>BUILTIN_POLICY_IDS.includes(x.id)).length,
  profanity:v(1,'These are shit.'),
  incentive:v(2,'I received these for free in exchange for an honest review.'),
  vine:v(2,'Vine review: I received these free in exchange for an honest review.'),
  sellerAskedChange:v(1,'The seller offered me a refund if I changed my review.'),
  pricingElsewhere:v(2,'Found the same set cheaper at Walmart.'),
  pricingValue:v(2,'Not worth the price at all.'),
  otherBrand:v(2,'Other brands are much better. The fabric pilled.'),
  offtopic:v(1,'Amazon refused to refund me.'),
  repetitiveSym:v(1,'!!!!!!!!!!!!'),
  shortOk:v(3,'It’s ok.'),
  orderOnly:v(1,'Item never arrived.'),
  orderMixed:v(2,'Two pillow cases had a large tear and there is no way to contact the company.'),
  missing:v(2,'Missing pieces, only received two pillow cases.'),
  draft:caseDraft({asin:'B0X',marketplace:'US',reviewId:'R1ABCDEFGH',classification:{evidence:'Item never arrived'}},policyById('POL-SELLER')),draftWords:wordCount(caseDraft({asin:'B0X',marketplace:'US',reviewId:'R1ABCDEFGH',classification:{evidence:'Item never arrived'}},policyById('POL-SELLER')))}});
console.log(JSON.stringify(cg));
ok(cg.count===8,'8 Community Guidelines policies in the register');
ok(cg.profanity==='clear_violation:POL-OFFENSIVE','profanity → CLEAR');
ok(cg.incentive==='clear_violation:POL-INCENTIVE','incentivized review → CLEAR');
ok(cg.vine.startsWith('clear_violation:POL-INCENTIVE'),'vine text still classified (the exclusion gate blocks it after classification)');
ok(cg.sellerAskedChange.startsWith('not_eligible'),'SAFEGUARD: review alleging we offered an incentive is never flagged');
ok(cg.pricingElsewhere.endsWith('POL-PRICING')&&cg.pricingValue.startsWith('not_eligible'),'price elsewhere flagged, value comment not');
ok(cg.otherBrand==='hold:POL-PROMO','other brand recommendation with product talk → HOLD');
ok(cg.offtopic==='clear_violation:POL-OFFTOPIC','Amazon service complaint → CLEAR');
ok(cg.repetitiveSym==='clear_violation:POL-REPETITIVE'&&cg.shortOk.startsWith('not_eligible'),'symbol spam flagged, short genuine review not');
ok(cg.orderOnly==='clear_violation:POL-SELLER'&&cg.orderMixed==='hold:POL-SELLER'&&cg.missing==='hold:POL-SELLER','order-only CLEAR, mixed and missing-pieces HOLD');
ok(/Community Guidelines category: Seller and order feedback/.test(cg.draft)&&/Guideline basis: Amazon's Community Guidelines state/.test(cg.draft)&&cg.draftWords<=150,'draft uses guideline category and basis, ≤150 words');

ok(errs.length===0,'no page errors '+errs.join('|'));
console.log(`\n${pass} passed, ${fail} failed`);await b.close();srv.close()})();
