// Regression checks for index.html (v5.2). Run: npm i playwright-core && node qa/regression.js index.html
// Uses local Chrome and pulls the live Master File tabs for the sync checks.
const {chromium}=require('playwright-core');const http=require('http'),fs=require('fs');
const html=fs.readFileSync(process.argv[2]);
const srv=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(html)}).listen(8767);
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const p=await b.newPage();const errs=[];p.on('dialog',d=>d.accept());p.setDefaultTimeout(60000);p.on('pageerror',e=>errs.push(e.message));
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
ok(Object.values(sync).every(x=>!x.error),'no sync errors');ok(sync['SYNC-CA'].invalid<=4,'CA spacer rows skipped, invalid now: '+sync['SYNC-CA'].invalid);ok(sync['SYNC-SKU'].added>1000,'SKU LIST imported '+sync['SYNC-SKU'].added);
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
ok(errs.length===0,'no page errors '+errs.join('|'));
console.log(`\n${pass} passed, ${fail} failed`);await b.close();srv.close()})();
