-- Owner-only verification. All fixtures and simulated time changes roll back.
begin;
do $$
declare u uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); a jsonb; b jsonb; s jsonb; p jsonb; expected numeric; cash numeric; n bigint;
begin
  insert into auth.users(id,raw_app_meta_data) values(u,'{"provider":"kakao"}');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'app_metadata',jsonb_build_object('provider','kakao'))::text,true);
  perform public.join_campus_league('loan_'||substr(u::text,1,12),'대출 검증대학');
  s:=public.get_campus_loan_state(u);
  if (s->>'available_credit')::numeric<>10000000 then raise exception 'initial credit failed: %',s; end if;
  a:=public.submit_campus_action(req,'loan','{"side":"borrow","amount":10000000}');
  b:=public.submit_campus_action(req,'loan','{"side":"borrow","amount":10000000}');
  if a<>b or (select cash_krw from public.campus_wallets where user_id=u)<>20000000 then raise exception 'borrow receipt failed'; end if;
  s:=public.get_campus_loan_state(u);
  if (s->>'net_equity')::numeric<>10000000 or (s->>'available_credit')::numeric<>0 then raise exception 'borrow inflated equity: %',s; end if;
  select value into p from jsonb_array_elements(public.get_campus_league_overview()->'schools') where value->>'school'='대출 검증대학';
  if (p->>'profit_krw')::numeric<>0 then raise exception 'borrow inflated school rank: %',p; end if;
  begin perform public.execute_campus_loan('borrow',1); raise exception 'second loan exceeded equity';
  exception when others then if sqlerrm='second loan exceeded equity' then raise; end if; end;
  begin perform public.execute_campus_loan('borrow','NaN'); raise exception 'NaN accepted';
  exception when others then if sqlerrm='NaN accepted' then raise; end if; end;
  update public.campus_wallets set cash_krw=60000000 where user_id=u;
  perform public.execute_campus_loan('borrow',40000000);
  s:=public.get_campus_loan_state(u);
  if (s->>'principal')::numeric<>50000000 or (s->>'net_equity')::numeric<>50000000 then raise exception 'grown equity limit failed'; end if;
  perform public.execute_campus_loan('repay',40000000);
  update public.campus_loans set last_accrued_at=now()-interval '31 days',next_due_at=now()-interval '1 hour',accrued_interest=0 where user_id=u;
  select cash_krw into cash from public.campus_wallets where user_id=u;
  expected:=trunc(10000000::numeric*0.08*(31*86400-3600)/31536000,2);
  perform public.settle_campus_loan(u);
  if (select cash_krw from public.campus_wallets where user_id=u)<>cash-expected then raise exception 'monthly charge wrong'; end if;
  select count(*) into n from public.campus_loan_events where user_id=u and kind='interest_payment';
  perform public.settle_campus_loan(u);
  if (select count(*) from public.campus_loan_events where user_id=u and kind='interest_payment')<>n then raise exception 'charged twice'; end if;
  perform public.execute_campus_loan('repay_all',0);
  if (select principal+interest_due+accrued_interest from public.campus_loans where user_id=u)<>0 then raise exception 'full payoff failed'; end if;
  if public.campus_next_billing_date('2026-01-31 00:00+09',31)<>'2026-02-28 00:00+09'::timestamptz or
    public.campus_next_billing_date('2026-02-28 00:00+09',31)<>'2026-03-31 00:00+09'::timestamptz then raise exception 'month-end anchor drift'; end if;

  update public.campus_wallets set cash_krw=2000000,cash_usd=0 where user_id=u;
  perform public.execute_campus_loan('borrow',1000000);
  insert into public.market_quotes(symbol,market,name,price,currency,source,freshness,is_tradable,as_of)
    values('QALOAN','KR','loan test',1000,'KRW','test','real_time',true,now());
  perform public.execute_campus_order('QALOAN','buy',2000);
  update public.campus_wallets set cash_krw=0 where user_id=u;
  update public.campus_loans set interest_due=10000 where user_id=u;
  perform public.settle_campus_loan(u);
  if (select bankrupt_at from public.campus_loans where user_id=u) is not null then raise exception 'cash shortage caused bankruptcy despite positive equity'; end if;
  begin perform public.execute_campus_order('QALOAN','buy',1); raise exception 'arrears allowed buy';
  exception when others then if sqlerrm='arrears allowed buy' then raise; end if; end;
  perform public.execute_campus_order('QALOAN','sell',20);
  if (select interest_due from public.campus_loans where user_id=u)<>0 then raise exception 'sell did not pay arrears'; end if;

  update public.market_quotes set price=1400,freshness='end_of_day',as_of=now(),is_tradable=true where symbol='USD/KRW';
  update public.campus_wallets set cash_usd=10,cash_krw=0 where user_id=u;
  update public.campus_loans set interest_due=10000 where user_id=u;
  perform public.convert_campus_usd_to_krw(10);
  if (select cash_krw from public.campus_wallets where user_id=u)<>4000 or (select interest_due from public.campus_loans where user_id=u)<>0 then raise exception 'USD recovery failed'; end if;
  update public.campus_loans set interest_due=2000000 where user_id=u;
  update public.market_quotes set as_of=now()-interval '10 days' where symbol='QALOAN';
  perform public.settle_campus_loan(u);
  if (select bankrupt_at from public.campus_loans where user_id=u) is not null then raise exception 'stale quote triggered bankruptcy'; end if;
  update public.market_quotes set as_of=now() where symbol='QALOAN';
  p:=public.get_my_campus_portfolio();
  if p->'loan'->>'bankrupt_at' is null then raise exception 'insolvency not recorded'; end if;
  a:=public.submit_campus_action(gen_random_uuid(),'loan','{"side":"borrow","amount":1}');
  if (a->>'ok')::boolean then raise exception 'bankrupt account borrowed'; end if;
  begin perform public.execute_campus_order('QALOAN','sell',1); raise exception 'bankrupt account traded';
  exception when others then if sqlerrm='bankrupt account traded' then raise; end if; end;
  begin perform public.join_campus_league('reset_attempt','대출 검증대학'); raise exception 'bankrupt account rejoined';
  exception when others then if sqlerrm='bankrupt account rejoined' then raise; end if; end;
  if has_function_privilege('authenticated','public.settle_campus_loan(uuid)','EXECUTE') or
    has_function_privilege('authenticated','public.settle_campus_loans_batch(integer)','EXECUTE') or
    has_table_privilege('authenticated','public.campus_loans','UPDATE') then raise exception 'private loan access exposed'; end if;
end;
$$;
select 'PASS: equity credit, no leverage loop, request replay, school return, 8% elapsed interest, monthly idempotency, partial/full payoff, month-end dates, arrears recovery, USD recovery, stale protection, bankruptcy lock and private access. Fixtures rolled back.' as verification;
rollback;
