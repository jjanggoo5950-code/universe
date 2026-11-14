# 운영 및 검증 기록 — 2026-11-15

## 반영 사항
- 계좌는 서버 보유 수량으로 계산. 최근 30건 내역은 거래 기록 표시용으로만 사용.
- 계정 전환 시 계좌 초기화, 브라우저 단독 참가/매매/환전 제거. 별명 수정은 DB 중복 검사와 저장을 거침. 학교는 최초 참가 학교 유지.
- 주문·환전 요청 ID를 서버 영수증과 함께 원자적으로 저장. 응답 유실 후 같은 ID 재요청은 기존 결과 반환. 잔액은 기존 행 잠금으로 직렬화.
- 화면에서 처리 중 버튼 잠금, 응답 미확인 요청 복구 버튼, 연결 오류 배너 제공.
- 시세: 같은 종목 동시 요청 병합, 개장 중 15초/장외 15분 캐시, KIS 공용 대기열 16개 및 최소 요청 간격 1.2초, HTTP 8초 제한, 일시 오류 최대 1회 재시도. 연속 실패 시 30초 차단.
- 무효/0/미래 시각 가격은 저장하지 않음. 실패 시 이전 가격과 원래 시각 보존, 반환 가격은 주문 불가. 오래된 가격은 서버에서도 주문 거절.
- 전체 순위는 Worker에서 20초 공유 캐시. 실패 시 최대 2분 이전 결과를 오래된 정보로 표시. 브라우저별 시세 이벤트 전체 재조회 제거; 30초~2분 재시도, 숨긴 탭은 일시 중지.
- 보유 중인 종목은 분당 최대 20개씩 순환 갱신. 매매 직전 검색으로 재조회 가능. 주식 장외 종가는 표시용이고 주문은 불가. 환율은 최근 거래일 값으로 가상 환전 가능.

## 검증
`node --test tests/resilience.test.mjs`: 동일 종목 동시 요청 1,000건과 순위 요청 1,000건이 각각 한 번의 원본 조회로 합쳐짐. 실패·캐시·대기열 초과·0원·미래 가격·차단기·30건 초과 보유 자산·계정 전환 검증.
`tests/database-rollback.sql`: 초기 자금, 재가입 자금 보존, 주문/환전 재전송, 요청 ID 내용 불일치, 32건 거래의 전체 보유 수량, 달러 없는 미국 주문 거부, null 주문 거부, 3분 전 시세 거부, 별명 중복 거부를 실제 DB 트랜잭션에서 검증 후 롤백.

## 운영상 한계와 확인할 지표
로컬 동시 요청 검사는 실제 1,000명 접속 부하 시험이나 수용 인원 보증이 아니다. KIS 한 계정의 허용량, Cloudflare/Supabase 요금제, 종목 다양성과 DB 데이터량이 실제 용량을 결정한다. 보유 종목이 많으면 정기 갱신 순환이 길어지고 순위 평가액도 마지막 수신 가격을 사용한다.
기본 시간 판정은 요일과 정규장 시각을 사용한다. 거래소 공휴일·임시 휴장·연장 세션의 정밀 캘린더와 미국 시세 공급 지연은 별도 보완 대상이다. 미국 API가 주는 가격의 실시간 이용 권한은 계정 조건에 따른다.
`/health`에서 last_fx_error, last_snapshot_error, queued_requests, upstream_circuit_open을 확인한다. 503/429·응답 지연·DB CPU·연결 수·청구량을 확인하며 트래픽을 단계적으로 늘린다. 대규모 사용 전 읽기용 순위 사전 집계, 전체 보유 종목 갱신 예산과 KIS 제공 한도를 조정해야 한다.
마이그레이션은 migrations/20261115_resilience.sql 및 20261115_held_quotes.sql. 신규 설치용 전체 SQL에도 포함됨. 비밀키는 Worker 환경에만 보관한다.

## Shared stock popularity
- Apply `migrations/20261115_popular_stocks.sql` before the matching frontend release.
- `popular_stocks` in the shared overview contains counts only; per-user search history has no client read/write grants.
- Holdings rank by distinct participants with a net positive share count. Search rank counts distinct Kakao users who successfully request a stock quote from search results in the last 7 days. Repeated searches never multiply a user's contribution.
- Search writes are deduplicated for an hour and capped at 60 distinct symbols per user per rolling 24 hours. A failed popularity write does not block a quote lookup.
- The home view shows 4 stocks; the market view shows up to 20, filtered by KR/US before limiting. If no one holds stocks, the default list uses recent searches. Empty lists are shown honestly without fixed stocks labeled as popular.
- Popularity uses the existing 20-second shared overview cache and 30–35-second foreground polling. Existing held-quote rotation also refreshes popular searched stocks, with the same bounded queue and stale-price trading checks.
- Browser fixtures use synthetic counts; database checks in `tests/popularity-rollback.sql` roll back all test data.
