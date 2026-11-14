# Campus League

한국·미국 주식을 이용한 대학생용 가상 투자 리그의 GitHub Pages 사이트입니다.

## 화면 기능

- 참가자마다 ₩10,000,000의 가상자금으로 시작
- 원화·달러 지갑과 USD/KRW 환전
- 한국·미국 주식 매수·매도 연습 및 장외 최근 종가 표시
- Cloudflare Worker의 KRX 실시간 시세와 국내·미국 최근 일봉 수집
- 학교별 수익금 합계와 참가자 평균 수익률
- 개인 최고 수익률·최저 수익률 기록
- 작은 화면에서도 쓸 수 있는 대시보드

## 미리보기

현재 예시 시세를 사용하는 데모가 기본 화면입니다. 브라우저에서 만든 계좌와 거래는 해당 브라우저에만 저장됩니다. 실제 가격 또는 다른 사람과 공유되는 순위로 오해하지 않도록 화면에서 데모 모드임을 표시합니다.

## 온라인 리그 준비

1. Supabase SQL Editor에서 campus_league_setup.sql을 실행합니다.
2. Supabase Authentication에서 익명 로그인을 활성화하고 Cloudflare Turnstile CAPTCHA를 설정합니다.
3. Cloudflare Workers Builds로 cloudflare-krx-worker 폴더를 배포하고, KIS 및 Supabase secret을 Worker 설정에 등록합니다.
4. 미국 주식은 KIS 최근 일봉 참고 가격을 표시하고 주문을 잠급니다. USD/KRW 실시간 환율과 미국 주식 실시간 시세는 별도 연결이 필요합니다.

자세한 안내는 캠퍼스리그_설정안내.md와 cloudflare-krx-worker/README.md를 참고하세요. 비밀 키나 service_role 키는 HTML, GitHub, 브라우저 코드에 넣지 마세요.

