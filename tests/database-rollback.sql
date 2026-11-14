-- Execute as project owner in SQL Editor. No fixture is committed.
begin;
do $$
declare
  u uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); r uuid:=gen_random_uuid();
  nick text:='qa_'||substr(u::text,1,12); p jsonb; before_cash numeric; a jsonb; b jsonb;
begin
  insert into auth.users(id,raw_app_meta_data) values(u,'{"provider":"kakao","providers":["kakao"]}'),(u2,'{"provider":"kakao","providers":["kakao"]}');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'app_metadata',jsonb_build_object('provider','kakao'))::text,true);
  perform public.join_campus_league(nick,'검증대학교');
  select cash_krw into before_cash from public.campus_wallets where user_id=u;
  if before_cash<>10000000 then raise exception 'initial funding failed'; end if;
  perform public.join_campus_league(nick,'검증대학교');
  if (select cash_krw from public.campus_wallets where user_id=u)<>before_cash then raise exception 'join reset funds'; end if;
  insert into public.market_quotes(symbol,market,name,price,currency,source,freshness,is_tradable,as_of)
    values('QA0001','KR','test',1000,'KRW','test','real_time',true,now()),('QA0002','US','test',10,'USD','test','real_time',true,now());
  for i in 1..31 loop
    perform public.submit_campus_action(gen_random_uuid(),'order','{"symbol":"QA0001","side":"buy","quantity":1}');
  end loop;
  a:=public.submit_campus_action(r,'order','{"symbol":"QA0001","side":"buy","quantity":1}');
  b:=public.submit_campus_action(r,'order','{"symbol":"QA0001","side":"buy","quantity":1}');
  if a<>b or (select count(*) from public.campus_trades where user_id=u)<>32 then raise exception 'idempotency failed'; end if;
  begin
    perform public.submit_campus_action(r,'order','{"symbol":"QA0001","side":"buy","quantity":2}');
    raise exception 'payload mismatch accepted';
  exception when others then if sqlerrm='payload mismatch accepted' then raise; end if; end;
  p:=public.get_my_campus_portfolio();
  if (p->'holdings'->0->>'quantity')::int<>32 or jsonb_array_length(p->'trades')<>30 then raise exception 'holdings truncated'; end if;
  begin
    perform public.execute_campus_order('QA0002','buy',1); raise exception 'USD without exchange accepted';
  exception when others then if sqlerrm='USD without exchange accepted' then raise; end if; end;
  begin
    perform public.execute_campus_order('QA0001',null,1); raise exception 'null side accepted';
  exception when others then if sqlerrm='null side accepted' then raise; end if; end;
  update public.market_quotes set as_of=now()-interval '3 minutes' where symbol='QA0001';
  begin
    perform public.execute_campus_order('QA0001','buy',1); raise exception 'stale quote accepted';
  exception when others then if sqlerrm='stale quote accepted' then raise; end if; end;
  update public.market_quotes set price=1400,freshness='end_of_day',as_of=now()-interval '1 day',is_tradable=true where symbol='USD/KRW';
  select cash_krw into before_cash from public.campus_wallets where user_id=u;
  r:=gen_random_uuid();
  perform public.submit_campus_action(r,'exchange','{"amount":1400}');
  perform public.submit_campus_action(r,'exchange','{"amount":1400}');
  if (select cash_krw from public.campus_wallets where user_id=u)<>before_cash-1400 then raise exception 'duplicate exchange'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u2,'app_metadata',jsonb_build_object('provider','kakao'))::text,true);
  begin
    perform public.join_campus_league(nick,'검증대학교'); raise exception 'duplicate nickname accepted';
  exception when unique_violation then null; end;
end;
$$;
select 'PASS: initial capital, repeat join, order/exchange idempotency, payload mismatch, 30+ holdings, USD balance, null side, stale quote, unique nickname. Fixtures rolled back.' as verification;
rollback;
