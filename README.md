# Campus League

한국·미국 주식을 이용한 대학생용 가상 투자 리그의 GitHub Pages 사이트입니다.

## 화면 기능

- 참가자마다 ₩10,000,000의 가상자금으로 시작
- 원화·달러 지갑과 USD/KRW 환전
- KIS 종목 목록에서 한국 약 2,878개·미국 약 6,586개 상장 주식을 이름이나 티커로 검색
- 선택한 종목의 KIS 현재가를 조회하고, 장외에는 최근 종가 표시
- 가상 현금과 보유 수량만 바꾸는 모의 매수·매도 (증권 주문 API는 호출하지 않음)
- Cloudflare Worker의 기본 KRX 실시간 시세와 국내·미국 최근 일봉 수집
- 학교별 수익금 합계와 참가자 평균 수익률
- 개인 최고 수익률·최저 수익률 기록
- 작은 화면에서도 쓸 수 있는 대시보드

## 미리보기

현재 예시 시세를 사용하는 데모가 기본 화면입니다. 브라우저에서 만든 계좌와 거래는 해당 브라우저에만 저장됩니다. 실제 가격 또는 다른 사람과 공유되는 순위로 오해하지 않도록 화면에서 데모 모드임을 표시합니다.

## 온라인 리그 준비

1. Supabase SQL Editor에서 campus_league_setup.sql을 실행합니다.
2. Supabase Authentication에서 익명 로그인을 활성화하고 Cloudflare Turnstile CAPTCHA를 설정합니다.
3. Cloudflare Workers Builds로 cloudflare-krx-worker 폴더를 배포하고, KIS 및 Supabase secret을 Worker 설정에 등록합니다.
4. 종목 검색은 KIS 마스터 목록에서 찾고, 선택한 종목의 가격만 Worker가 KIS 조회 API로 가져옵니다. 장외 최근 종가는 참고용이라 주문이 잠깁니다. 모든 주문은 Supabase 모의 계좌에서만 처리되며 실제 증권 주문 API를 호출하지 않습니다. USD/KRW 환율 연결은 별도 설정입니다.

자세한 안내는 캠퍼스리그_설정안내.md와 cloudflare-krx-worker/README.md를 참고하세요. 비밀 키나 service_role 키는 HTML, GitHub, 브라우저 코드에 넣지 마세요.

