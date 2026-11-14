import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { KisCollector } from '../cloudflare-krx-worker/src/index.js';
const collector = () => new KisCollector({storage:{get:async()=>null,put:async()=>{}}}, {});
const asset = {market:'KR',symbol:'005930',exchange:'',name:'삼성전자'};
const quote = () => ({...asset,price:70000,as_of:new Date().toISOString(),is_tradable:true,freshness:'real_time'});

test('1,000 concurrent requests for one symbol use one upstream call and one DB write',async()=>{
  const c=collector(); let calls=0,writes=0;
  c.loadOnDemandQuote=async()=>{calls++; await new Promise(r=>setTimeout(r,10));return quote();};
  c.publishQuote=async()=>{writes++;return true;};
  const results=await Promise.all(Array.from({length:1000},()=>c.fetchOnDemandQuote(asset)));
  assert.equal(calls,1);assert.equal(writes,1);assert.equal(results.length,1000);
  await c.fetchOnDemandQuote(asset);assert.equal(calls,1);
});
test('failure preserves last good value and timestamp but disables the returned quote',async()=>{
  const c=collector(), q=quote();
  c.quoteCache.set('KR::005930',{fetchedAt:0,quote:q});
  c.loadOnDemandQuote=async()=>{throw Error('timeout');};
  const result=await c.fetchOnDemandQuote(asset);
  assert.equal(result.price,q.price);assert.equal(result.as_of,q.as_of);assert.equal(result.is_tradable,false);assert.equal(result.stale,true);
});
test('bounded queue rejects overload before fetching; zero and future quotes are never persisted',async()=>{
  const c=collector();c.restQueued=16;
  await assert.rejects(c.fetchUpstream('https://openapi.koreainvestment.com:9443/test'),/busy/);
  assert.equal(await c.writeQuote({...quote(),price:0}),false);
  assert.equal(await c.writeQuote({...quote(),as_of:'2999-01-01'}),false);
});
test('FX response without a provider timestamp falls back to dated closing rate instead of pretending to be live',async()=>{
  const c=collector(); let calls=0, saved;
  const d=new Date(Date.now()-2*86400000).toISOString().slice(0,10).replaceAll('-','');
  c.getRestAccessToken=async()=> 'fake';
  c.fetchUpstream=async()=>{calls++;return Response.json(calls===1 ? {rt_cd:'0',output1:{ovrs_nmix_prpr:'9999'}} : {rt_cd:'0',output1:{ovrs_nmix_prpr:'9999'},output2:[{stck_bsop_date:d,ovrs_nmix_prpr:'1400'}]});};
  c.publishQuote=async q=>{saved=q;return true;};
  await c.refreshFxQuote(Date.now());
  assert.equal(calls,2);assert.equal(saved.price,1400);assert.equal(saved.freshness,'end_of_day');assert.ok(Date.parse(saved.as_of)<Date.now()-86400000);
});
test('1,000 overview readers share one database calculation, then reuse cached result',async()=>{
  const original=global.fetch;let calls=0;
  global.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Response.json({quotes:[],schools:[]});};
  try { const c=collector();await Promise.all(Array.from({length:1000},()=>c.getOverview()));await c.getOverview();assert.equal(calls,1); }
  finally {global.fetch=original;}
});
test('repeated upstream 500 responses open the circuit and do not retry forever',async()=>{
  const original=global.fetch;let calls=0;
  global.fetch=async()=>{calls++;return Response.json({msg_cd:'EGW00201'},{status:500});};
  try {const c=collector();await assert.rejects(c.fetchUpstream('https://openapi.koreainvestment.com:9443/test'));await assert.rejects(c.fetchUpstream('https://openapi.koreainvestment.com:9443/test'));assert.equal(calls,3);assert.ok(c.circuitUntil>Date.now());await assert.rejects(c.fetchUpstream('https://openapi.koreainvestment.com:9443/test'));assert.equal(calls,3);}
  finally{global.fetch=original;}
});
test('portfolio values use authoritative holdings beyond the latest 30 trades; account switch clears data',()=>{
  const nodes=new Map();
  const node=()=>({value:'1',dataset:{},children:[],classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},toggleAttribute(){},replaceChildren(){},append(){},querySelectorAll(){return [];},closest(){return null;},focus(){}});
  const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelector(){return node();},querySelectorAll(){return [];},createElement:node};
  const window={location:{origin:'https://example.com',pathname:'/'},clearTimeout(){}};
  const context={window,document,navigator:{onLine:true},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},console,Intl,Date,Map,Set,URL,URLSearchParams,setTimeout:()=>0,clearTimeout(){},crypto};
  vm.createContext(context);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInContext(script,context);
  const app=window.CampusLeague;
  app.setAuthUser({id:'a',app_metadata:{provider:'kakao'}});
  app.applyRemoteOverview({quotes:[{symbol:'005930',market:'KR',name:'삼성전자',currency:'KRW',price:100,change_pct:0,freshness:'real_time',is_tradable:true,as_of:new Date().toISOString()}],schools:[]});
  app.applyRemotePortfolio({profile:{nickname:'test',school:'test'},wallet:{cash_krw:1000,cash_usd:0},holdings:[{symbol:'005930',quantity:41,price:100,currency:'KRW',name:'삼성전자'}],trades:Array.from({length:30},()=>({symbol:'005930',side:'sell',quantity:1,price:100,currency:'KRW',created_at:new Date().toISOString()}))});
  assert.equal(nodes.get('stat-assets').textContent,'₩5,100');
  assert.match(nodes.get('portfolio-holdings').innerHTML,/41주/);
  app.setAuthUser({id:'b',app_metadata:{provider:'kakao'}});
  assert.equal(nodes.get('stat-assets').textContent,'₩10,000,000');
});
