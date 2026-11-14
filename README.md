# Orbiting Code — ASCII Solar System

작은 글자와 점, 빛으로 그린 움직이는 태양계입니다. 방문자의 방명록 글은 행성이 되고, 하나씩 모여 은하를 만듭니다.

## 웹에서 보기

<https://jjanggoo5950-code.github.io/universe/>

`main` 브랜치에 변경 사항을 올리면 GitHub Actions가 페이지를 다시 배포합니다.

## 익명 방명록 설정

방명록은 Supabase 데이터베이스와 Cloudflare Turnstile 봇 방지를 사용합니다. Supabase에서 익명 로그인을 켜고 SQL 정책을 적용한 뒤 CAPTCHA를 설정해야 글을 저장할 수 있습니다. 순서는 [방명록 설정 안내](방명록_설정_안내.md)를 참고하세요.

## Python 터미널 애니메이션

Python 3만 있으면 실행할 수 있습니다. 외부 패키지는 필요하지 않습니다.

```bash
python solar_system_ascii.py
```

- `Space`: 일시정지 / 재생
- `+` 또는 `-`: 공전 속도 조절
- `Q`: 종료
- `python solar_system_ascii.py --once`: 한 장면만 출력

행성 크기와 궤도는 시각화를 위한 표현이며 실제 비율과 다릅니다.

