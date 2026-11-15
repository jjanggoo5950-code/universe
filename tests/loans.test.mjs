import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {KisCollector} from '../cloudflare-krx-worker/src/index.js';
function fixture(){
 const nodes=new Map();const node=()=>({value:'1',dataset:{},children:[],classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},toggleAttribute(){},replaceChildren(){},append(){},querySelectorAll(){return[];},closest(){return null;},focus(){}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelector:node,querySelectorAll:()=>[],createElement:node};
 const window={location:{origin:'https://test.invalid',pathname:'/'}};
 const ctx={window,document,navigator:{onLine:true},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},console,Intl,Date,Map,Set,URL,URLSearchParams,setTimeout:()=>0,clearTimeout(){},crypto};
 vm.createContext(ctx);vm.runInContext([...fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1],ctx);
 return{app:window.CampusLeague,nodes};
}
const loan=()=>({principal:10000000,accrued_interest:0,interest_due:0,can_borrow:true,season_ends_at:'2027-01-01T00:00:00+09:00',season_closed:false,next_due_at:'2026-12-15T00:00:00+09:00',events:[]});
test('loan proceeds do not increase net worth; interest decreases it and account changes clear the debt',()=>{
 const {app,nodes}=fixture();app.setAuthUser({id:'borrower',app_metadata:{provider:'kakao'}});
 const portfolio={profile:{nickname:'test',school:'test'},wallet:{cash_krw:20000000,cash_usd:0},holdings:[],trades:[],loan:loan()};
 app.applyRemotePortfolio(portfolio);assert.equal(nodes.get('stat-assets').textContent,'₩10,000,000');assert.equal(nodes.get('stat-return').textContent,'0.00%');
 app.applyRemotePortfolio({...portfolio,loan:{...loan(),interest_due:10000,accrued_interest:5000,can_borrow:false}});
 assert.equal(nodes.get('stat-assets').textContent,'₩9,985,000');assert.equal(nodes.get('loan-borrow').disabled,true);
 app.setAuthUser({id:'other',app_metadata:{provider:'kakao'}});assert.equal(nodes.get('stat-assets').textContent,'₩10,000,000');assert.equal(nodes.get('loan-principal').textContent,'₩0');
});
test('bankruptcy freezes the final result and disables trading, borrowing and repayments',()=>{
 const {app,nodes}=fixture();app.setAuthUser({id:'bankrupt',app_metadata:{provider:'kakao'}});
 app.applyRemotePortfolio({profile:{nickname:'test',school:'test'},wallet:{cash_krw:50000000,cash_usd:0},holdings:[],trades:[],loan:{...loan(),bankrupt_at:new Date().toISOString(),final_equity:-1000}});
 assert.equal(nodes.get('stat-assets').textContent,'₩-1,000');assert.equal(nodes.get('loan-borrow').disabled,true);assert.equal(nodes.get('loan-repay').disabled,true);assert.equal(nodes.get('trade-submit').disabled,true);assert.equal(nodes.get('loan-game-status').hidden,false);
});
test('monthly scheduler shares a single bounded batch across simultaneous calls',async()=>{
 const saved=new Map();const original=global.fetch;let calls=0;
 global.fetch=async()=>{calls++;return Response.json({processed:100});};
 try{const c=new KisCollector({storage:{get:async k=>saved.get(k),put:async(k,v)=>saved.set(k,v)}},{SUPABASE_SECRET_KEY:'test'});
 await Promise.all(Array.from({length:1000},()=>c.settleLoans()));await c.settleLoans();assert.equal(calls,1);assert.equal(saved.get('loanSettlementStatus').processed,100);
 }finally{global.fetch=original;}
});
