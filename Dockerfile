# 데모 배포용 이미지 — 서버 + 빌드된 화면 두 개 + MQTT 브로커 + 목 게이트웨이를
# 한 컨테이너에 담는다. Render·Railway·Fly·일반 VPS 어디든 이 파일 하나로 뜬다.
#
# ⚠️ 시연 전용. /dev-token 이 살아 있어 링크를 아는 사람은 전원의 위치를 본다.
#    실제 환자 데이터에는 쓰지 말 것.

FROM node:22-slim

# better-sqlite3 는 네이티브 모듈 — prebuild 가 없는 플랫폼에서는 여기서 컴파일한다
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 — 소스만 바뀌면 이 층은 캐시가 살아 재빌드가 빠르다.
# 워크스페이스라 각 package.json 이 다 있어야 npm ci 가 그래프를 푼다.
COPY package.json package-lock.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/server/package.json      packages/server/
COPY packages/web-staff/package.json   packages/web-staff/
COPY packages/web-patient/package.json packages/web-patient/

# devDependencies 도 설치한다 — 서버를 tsx 로 돌리고(@meditracker/shared 가 TS 소스를
# 그대로 내보낸다), 목 MQTT 브로커(aedes)도 dev 쪽에 있다.
RUN npm ci

COPY . .

# 화면 두 개를 정적 파일로 빌드 → 서버가 /(직원용) 과 /patient/(환자용) 로 서빙한다
RUN npm run build:demo

# SQLite 파일 자리. 무료 호스팅은 재배포마다 초기화되지만 시연에는 문제없다
# (부팅할 때 시드를 다시 넣는다).
RUN mkdir -p packages/server/data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start:demo"]
