# AWS EC2 배포 — 대외 시연용 한 대

`https://<도메인>` 하나로 직원용·환자용·관제가 다 열리는 구성. EC2 한 대에 컨테이너 둘
(meditracker + Caddy)이고, 화면을 따로 호스팅하지 않는다 — 서버가 화면까지 서빙한다.

```
rtls.<도메인>  ─443─▶  EC2 t3.small (Elastic IP)
                        ├ Caddy         : TLS 자동발급 + 8080 리버스 프록시
                        └ meditracker   : 브로커 + 시드 + 서버 + 목 게이트웨이 (한 프로세스)
                           볼륨 ./data → SQLite

/  직원용(핀)   ·   /patient/  환자용(핀 없음)   ·   /monitor  관제(핀)
```

> ⚠️ **여기 들어오는 신호는 목 게이트웨이가 만든 가상 데이터다.** 원내 게이트웨이는 같은
> LAN 의 브로커로만 쏘므로 클라우드까지 오지 않는다. 실운영 본체는 계속 원내 PC 다
> (README「실제 병원 설치는 이 방식이 아니다」).

---

## 0. 시작 전 확정

| 항목 | 왜 먼저인가 |
|---|---|
| 서브도메인 (예 `rtls.example.com`) | 인증서가 도메인 기준이다. IP 만으로는 https 가 안 된다 |
| DNS 관리 위치 (Route 53?) | A 레코드를 넣을 곳 |
| 리전 | 서울(`ap-northeast-2`) 기준으로 아래 값을 골랐다 |

---

## 1. 인스턴스 (콘솔, 15분)

- **t3.small** / **Ubuntu 24.04 LTS**(또는 Amazon Linux 2023) / gp3 20GB
  - 아래 명령은 **Ubuntu 기준**이다. Amazon Linux 를 골랐으면 `apt-get` → `dnf`,
    접속 계정 `ubuntu` → `ec2-user` 로 바꿔 읽는다. 어느 쪽인지는 서버에서
    `cat /etc/os-release` 로 확인한다.
  - ⚠️ **키 페어를 반드시 지정하고 `.pem` 을 받아 둔다.** "키 페어 없이 계속" 으로 만들면
    SSH 로 못 들어간다(`Permission denied (publickey)`). 그 경우 콘솔의
    **연결 → EC2 Instance Connect** 로 브라우저 터미널을 쓰면 작업은 계속할 수 있다.
  - ⚠️ 계정 이름이 틀려도 증상이 똑같이 `Permission denied (publickey)` 다. Ubuntu 에
    `ec2-user@` 로 붙으면 이 에러가 난다 — 키 문제로 오해하기 쉽다.
  - **t3 = amd64.** t4g(Graviton)를 고르면 이미지 아키텍처가 안 맞아 `exec format error` 로
    컨테이너가 안 뜬다. 굳이 t4g 를 쓸 거면 이미지를 arm64 로 빌드해야 한다.
  - t3.micro(1GB)는 이미지 빌드에서 OOM(exit 137) 위험이 있다. 2단계 swap 은 그 보험이다.
- **Elastic IP 할당 + 인스턴스에 연결** — A 레코드가 IP 를 가리키므로 재부팅에 바뀌면 안 된다.
  - 할당(주소 만들기)과 연결(인스턴스에 붙이기)은 **다른 작업**이다. 연결 화면은
    EC2 → 탄력적 IP 주소 목록 → 체크 → **작업 → 탄력적 IP 주소 연결**.
  - 연결하면 인스턴스의 **퍼블릭 IPv4 주소가 그 값으로 바뀐다.** 두 값이 다르면 아직
    연결이 안 된 것이고, 예전 주소로 접속하면 타임아웃이 난다.
  - 할당만 하고 연결하지 않은 IP 에는 요금이 붙는다.
- **보안 그룹 인바운드**: `80`, `443` 을 `0.0.0.0/0`
  - 80 도 필요하다 — 인증서 발급 확인과 https 리다이렉트에 쓴다.
  - **8080 은 열지 않는다** (Caddy 가 로컬로 물어간다). **1883 은 절대 열지 않는다** —
    브로커는 프로세스 안에서 루프백 전용이다.
  - 접속은 **EC2 Instance Connect** (콘솔 → 인스턴스 → 연결). SSH 키를 관리하지 않는다.
- **A 레코드** `rtls.<도메인>` → Elastic IP.

**전파를 확인하고 나서 2단계로 간다.** 안 기다리고 컨테이너를 올리면 인증서 발급이 실패하고,
실패가 쌓이면 Let's Encrypt 한도에 걸려 몇 시간~일주일 막힌다.

```bash
dig +short rtls.example.com
```

---

## 2. 서버 준비 (Instance Connect, 20분)

```bash
sudo apt-get update && sudo apt-get install -y docker.io git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

`usermod` 은 **다시 접속해야** 적용된다. 지금 창에서 바로 쓰려면 `newgrp docker`.
`docker ps` 가 에러 없이 나오면 통과 — `permission denied ... docker.sock` 이 뜨면
아직 그룹이 안 붙은 것이다.

compose 플러그인:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

**swap 2GB** — `npm ci`(better-sqlite3 네이티브 컴파일) + Vite 빌드 2개가 2GB 램에서 아슬아슬하다:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

---

## 3. 코드와 `.env`

```bash
cd ~ && git clone https://github.com/bluebeatle97/meditacker_test.git meditracker && cd meditracker
```

**도메인이 아직 없으면 `sslip.io` 로 먼저 띄운다.** IP 를 하이픈으로 바꾼 이름이 그 IP 를
가리키는 공개 DNS 서비스라(`43-200-199-176.sslip.io`), 회사 DNS 를 기다리지 않고 정식
인증서까지 받을 수 있다. 아래 명령은 서버가 **자기 공인 IP 를 스스로 읽어** 채운다:

```bash
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60"); IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4); printf 'SITE_DOMAIN=%s.sslip.io\nSTAFF_PIN=<핀>\nJWT_SECRET=%s\nMOCK_SPEED=1\n' "${IP//./-}" "$(openssl rand -hex 32)" > .env; chmod 600 .env; cat .env
```

회사 도메인이 준비되면 `.env` 의 `SITE_DOMAIN` 한 줄만 그 도메인으로 바꾸고
`up -d` 하면 인증서를 새로 받는다.

- `STAFF_PIN` — 직원용·관제 진입 핀. **이 값이 곧 "누가 전원의 위치를 볼 수 있나" 다.**
  ⚠️ **이 저장소는 공개다.** 코드의 기본값 `000111` 은 누구나 읽을 수 있으므로 **배포에서는
  반드시 다른 값**을 쓴다. 기본값을 그대로 두면 핀이 걸려 있어도 걸려 있지 않은 것과 같다.
- `JWT_SECRET` — 위 명령이 랜덤으로 넣는다. 이걸 기본값으로 두면 남이 토큰을 위조할 수 있다.
- `.env` 는 저장소에 커밋하지 않는다 (`.gitignore` 에 이미 있다).

---

## 4. 기동

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

첫 빌드는 5~10분(better-sqlite3 컴파일 + 화면 2개 빌드). 그다음 **인증서 발급을 먼저 확인**한다:

```bash
docker compose -f docker-compose.prod.yml logs caddy | grep -i "certificate\|error"
```

`certificate obtained successfully` 가 보이면 됐다. 안 나오면 아래 트러블슈팅.

### 검증 (이 순서로)

```bash
# ① 서버가 살아 있나
curl -s https://rtls.example.com/health

# ② 도면 데이터는 공개 (화면이 이걸로 '서버 살아 있음' 을 판단한다)
curl -s -o /dev/null -w '%{http_code}\n' https://rtls.example.com/zones          # 200

# ③ 직원 전용은 막혀 있나 — 401 이 정상이다
curl -s -o /dev/null -w '%{http_code}\n' https://rtls.example.com/beacons        # 401

# ④ 개발 창구가 닫혔나 — 404 가 정상이다
curl -s -o /dev/null -w '%{http_code}\n' https://rtls.example.com/dev-token      # 404

# ⑤ 핀으로 토큰이 나오나
curl -s -X POST -d '{"pin":"<핀>"}' https://rtls.example.com/staff-token
```

브라우저에서:

| 주소 | 기대 |
|---|---|
| `/` | 핀 상자가 뜬다 → 핀 넣으면 도면·비콘 목록. **'시연용 가상 데이터' 배지가 없어야** 진짜 서버에 붙은 것 |
| `/monitor` | 핀 상자 → 게이트웨이 표에 스캔이 들어옴 |
| `/patient/` | 핀 없이 열린다 (환자는 핀을 모른다) |

마지막으로 **재부팅 한 번** 하고 자동으로 다시 뜨는지 본다 (`restart: unless-stopped`).

---

## 5. 자동 배포 (다음 단계)

지금은 손으로 배포한다:

```bash
cd ~/meditracker && git pull && docker compose -f docker-compose.prod.yml up -d --build
```

다음 단계는 medibible 과 같은 형태다 — `main` push → GitHub Actions 에서 이미지 빌드 → ECR →
EC2 에서 pull & 재기동. **빌드를 Actions 로 옮기는 것이 핵심**이라 EC2 OOM 이 구조적으로
사라지고, 이미지 태그로 롤백도 된다.

> ⚠️ 재기동하면 붙어 있던 소켓이 다 끊기고 존 판정이 처음부터 다시 수렴한다(인메모리 상태).
> medibible 처럼 "배포 중 잠깐 죽어도 무해" 하지 않다 — 시연 중에는 배포하지 않는다.

---

## 트러블슈팅

| 증상 | 원인과 처방 |
|---|---|
| 인증서 발급 실패 | ① DNS 미전파 (`dig +short` 로 EIP 확인) ② 80 미개방 ③ CNAME 으로 넣음(A 여야 한다). **고치기 전에 컨테이너를 계속 올리지 말 것** — 실패가 쌓이면 발급 한도에 걸린다 |
| 502 | Caddy 는 살아 있고 서버가 죽었다 → `docker compose -f docker-compose.prod.yml logs meditracker --tail=50` |
| 화면에 '시연용 가상 데이터' 배지 | 화면이 `/zones` 를 못 받았다 = 서버·프록시 문제. 배지는 지우지 말고 원인을 고친다 |
| 핀이 계속 틀리다고 나옴 | `.env` 의 `STAFF_PIN` 과 다른 값. 바꿨으면 `up -d` 로 컨테이너를 다시 만들어야 반영된다 |
| `시도가 너무 많습니다` | 연속 5회 실패로 60초 잠김. 기다리면 풀린다 |
| 빌드가 exit 137 | 메모리 부족 → 2단계 swap 확인 (`free -h`) |
| `exec format error` | arm64 인스턴스에 amd64 이미지. t3 로 가거나 이미지를 arm64 로 빌드 |
| 관제에서 스캔이 0 | 목 게이트웨이가 죽었다 → meditracker 로그 확인 |

### 자주 쓰는 명령

```bash
cd ~/meditracker
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs meditracker --tail=50
docker compose -f docker-compose.prod.yml restart meditracker
docker compose -f docker-compose.prod.yml down          # 전체 정지
```

핀만 바꿀 때:

```bash
sed -i 's/^STAFF_PIN=.*/STAFF_PIN=<새핀>/' .env
docker compose -f docker-compose.prod.yml up -d         # 컨테이너 재생성 = 반영
```

---

## 남아 있는 위험 (알고 배포할 것)

- **핀 한 겹이 전부다.** 핀을 아는 사람은 전원의 실명과 위치를 본다. 실제 환자 데이터를
  붙인 채로 공개 URL 에 두면 안 된다 — 지금 도는 것은 가상 인원이다.
- **환자용은 핀이 없다.** 그래야 환자가 QR 로 들어온다. 대신 환자 화면은 서버가 필터링해서
  남의 위치를 안 보낸다 (`patient-privacy.test.ts`).
- **핀 잠금은 IP 기준**이고 프록시가 넘겨주는 헤더를 믿는다. 위조하면 잠금을 우회할 수 있다 —
  근본 대책은 더 긴 핀이다.
