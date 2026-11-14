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

## 계정과 데이터

참가와 거래에는 카카오 로그인이 필요합니다. 온라인 포트폴리오와 순위는 Supabase에 저장되어 다른 브라우저에서도 같은 카카오 계정으로 불러올 수 있습니다. 공개 순위에는 사용자가 입력한 게임 별명과 학교만 표시하며 카카오 실명이나 프로필명은 표시하지 않습니다.

## 온라인 리그 준비

1. 이 저장소의 `campus_league_setup.sql`을 Supabase SQL Editor에서 실행합니다.
2. Kakao Developers에서 카카오 로그인을 켜고 앱을 만듭니다. Supabase의 Kakao 제공자에 REST API 키와 Client Secret을 등록하고, Supabase 콜백 URL을 Kakao에 등록합니다.
3. Supabase Auth의 Kakao 제공자와 사이트 URL을 설정합니다. 이전 익명 참가 기록 연결을 위해 수동 계정 연결을 켜고, Anonymous sign-ins는 끕니다. 변경된 SQL 파일도 다시 실행해 카카오 계정만 참가·매매할 수 있게 합니다.
4. Cloudflare Worker에 KIS 및 Supabase 서버 비밀키를 등록합니다. 종목 검색은 KIS 목록을 사용하고 선택한 종목 가격만 조회합니다. 주문은 가상 계좌에만 반영하며 증권 주문 API를 호출하지 않습니다.

USD/KRW 환율 피드는 별도 설정입니다. 자세한 Kakao/Supabase 설정과 기존 참가자 데이터 이전은 `캠퍼스리그_설정안내.md`를 참고하세요. 비밀 키나 service_role 키는 HTML, GitHub, 브라우저 코드 또는 채팅에 올리지 마세요.

자세한 안내는 캠퍼스리그_설정안내.md와 cloudflare-krx-worker/README.md를 참고하세요. 비밀 키나 service_role 키는 HTML, GitHub, 브라우저 코드에 넣지 마세요.

