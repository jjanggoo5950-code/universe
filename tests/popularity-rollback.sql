-- Test data lives only in this transaction.
begin;
do $$
declare
  u uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); p jsonb; n int;
begin
  insert into auth.users(id,raw_app_meta_data) values
    (u,'{"provider":"kakao"}'),(u2,'{"provider":"kakao"}');
  insert into public.market_quotes(symbol,market,name,price,currency,source,freshness,is_tradable,as_of)
    values('QAPOP1','KR','Popularity test',1000,'KRW','test','real_time',true,now());
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'app_metadata',jsonb_build_object('provider','kakao'))::text,true);
  perform public.join_campus_league('qa_'||substr(u::text,1,12),'인기순위 검증대학');
  perform public.execute_campus_order('QAPOP1','buy',100);
  perform public.record_campus_stock_search('QAPOP1');
  perform public.record_campus_stock_search('qapop1');
  select value into p from jsonb_array_elements(public.get_campus_popular_stocks()) where value->>'symbol'='QAPOP1';
  if p is null or (p->>'holder_count')::int<>1 or (p->>'search_count')::int<>1 then raise exception 'duplicate user counting failed'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u2,'app_metadata',jsonb_build_object('provider','kakao'))::text,true);
  perform public.join_campus_league('qa_'||substr(u2::text,1,12),'인기순위 검증대학');
  perform public.execute_campus_order('QAPOP1','buy',1);
  perform public.record_campus_stock_search('QAPOP1');
  select value into p from jsonb_array_elements(public.get_campus_league_overview()->'popular_stocks') where value->>'symbol'='QAPOP1';
  if (p->>'holder_count')::int<>2 or (p->>'search_count')::int<>2 then raise exception 'shared counts failed'; end if;
  perform public.execute_campus_order('QAPOP1','sell',1);
  update public.campus_stock_searches set searched_at=now()-interval '8 days' where user_id=u2;
  select value into p from jsonb_array_elements(public.get_campus_popular_stocks()) where value->>'symbol'='QAPOP1';
  if (p->>'holder_count')::int<>1 or (p->>'search_count')::int<>1 then raise exception 'sold-out or old search counted'; end if;
  if public.record_campus_stock_search('USD/KRW') or public.record_campus_stock_search('NO_SUCH_STOCK') then raise exception 'invalid stock accepted'; end if;
  for n in 1..61 loop
    insert into public.market_quotes(symbol,market,name,price,currency,source,freshness,is_tradable,as_of)
      values('QP'||lpad(n::text,4,'0'),'KR','limit test',1000,'KRW','test','end_of_day',false,now());
    if n<=60 and not public.record_campus_stock_search('QP'||lpad(n::text,4,'0')) then raise exception 'valid search rejected'; end if;
  end loop;
  if public.record_campus_stock_search('QP0061') then raise exception 'search cap not enforced'; end if;
  if has_table_privilege('authenticated','public.campus_stock_searches','SELECT') or
    has_table_privilege('authenticated','public.campus_stock_searches','INSERT') or
    has_function_privilege('anon','public.record_campus_stock_search(text)','EXECUTE') then raise exception 'search history permissions exposed'; end if;
  perform set_config('request.jwt.claims','{}',true);
  begin
    perform public.record_campus_stock_search('QAPOP1'); raise exception 'anonymous accepted';
  exception when others then if sqlerrm='anonymous accepted' then raise; end if; end;
end;
$$;
select 'PASS: shared holders, sold-out removal, distinct searches, 7-day window, invalid stocks, daily cap, private history and login. All fixtures rolled back.' as verification;
rollback;
