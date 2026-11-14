import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page() {
  const nodes=new Map();
  const node=(dataset={})=>({value:'1',dataset,children:[],handlers:{},classList:{add(){},remove(){},toggle(){}},
    addEventListener(name,fn){this.handlers[name]=fn;},setAttribute(){},toggleAttribute(){},
    replaceChildren(){this.children=[];},append(child){this.children.push(child);},querySelectorAll(){return [];},closest(){return null;},focus(){}});
  const modes=['holders','searches'].map(popularity=>node({popularity}));
  const markets=['ALL','KR','US'].map(market=>node({market}));
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelector:()=>node(),
    querySelectorAll(s){return s==='[data-popularity]'?modes:s==='[data-market]'?markets:[];},createElement:()=>node()};
  const window={location:{origin:'https://test.invalid',pathname:'/'}};
  const context={window,document,navigator:{onLine:true},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},console,Intl,Date,Map,Set,URL,URLSearchParams,setTimeout:()=>0,clearTimeout(){},crypto,
    fetch:async()=>({ok:false})};
  vm.createContext(context);
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  vm.runInContext([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1],context);
  return {app:window.CampusLeague,nodes,modes,markets};
}
const quote=(symbol,market='KR')=>({symbol,market,name:symbol,currency:market==='KR'?'KRW':'USD',price:100,change_pct:0,freshness:'end_of_day',is_tradable:false,as_of:'2026-11-13T06:30:00Z'});
test('shared holder/search counts determine order, and market filters apply before limiting',()=>{
  const {app,nodes,modes,markets}=page();
  app.applyRemoteOverview({schools:[],quotes:[quote('005930'),quote('QA0001'),quote('QA0002'),quote('USPOP','US')],popular_stocks:[
    {symbol:'QA0001',market:'KR',holder_count:2,search_count:50},
    {symbol:'QA0002',market:'KR',holder_count:5,search_count:1},
    {symbol:'USPOP',market:'US',holder_count:8,search_count:20}
  ]});
  const rows=()=>nodes.get('market-rows-secondary').children.map(r=>r.innerHTML);
  assert.equal(rows().length,3); assert.match(rows()[0],/USPOP/);assert.match(rows()[1],/QA0002/);
  assert.ok(rows().every(row=>!row.includes('005930')));
  modes[1].handlers.click(); assert.match(rows()[0],/QA0001/);assert.match(rows()[0],/50명 검색/);
  markets[2].handlers.click();assert.equal(rows().length,1);assert.match(rows()[0],/USPOP/);
});
test('no synthetic popularity; searches become the initial list when no stocks are held',()=>{
  const {app,nodes}=page();
  app.applyRemoteOverview({schools:[],quotes:[quote('005930')],popular_stocks:[]});
  assert.equal(nodes.get('market-rows').children.length,0);
  app.applyRemoteOverview({schools:[],quotes:[quote('005930')],popular_stocks:[{symbol:'005930',market:'KR',holder_count:0,search_count:1}]});
  assert.equal(nodes.get('market-rows').children.length,1);
  assert.match(nodes.get('market-rows').children[0].innerHTML,/1명 검색/);
});
