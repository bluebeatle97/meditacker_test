-- 설계서 9. DB 스키마 (SQLite)

CREATE TABLE IF NOT EXISTS zones (
  zone_id TEXT PRIMARY KEY, name TEXT, type TEXT, category TEXT,
  tile_x INTEGER, tile_y INTEGER, social_enabled INTEGER
);

CREATE TABLE IF NOT EXISTS gateways (
  gateway_id TEXT PRIMARY KEY, zone_id TEXT, label TEXT
);

-- ⚠️ 구버전 테이블. beacons + assignments 로 갈라졌다 (아래 참고).
-- 이관 뒤에는 아무도 읽지 않지만, 되돌릴 일이 있을 수 있어 한동안 남겨둔다.
CREATE TABLE IF NOT EXISTS tags (
  tag_id TEXT PRIMARY KEY, person_id TEXT, person_type TEXT,
  assigned_at INTEGER, active INTEGER
);

-- 하드웨어 대장 — 비콘 하나당 평생 한 줄.
--
-- '등록' 은 이 표에 올리는 일이고 비콘당 한 번뿐이다. 누가 들고 있는지는 여기 없다.
-- 화이트리스트(추적 허용)의 원본이 이 표다 — 창고에 있는 비콘도 전원이 켜져 있어
-- 신호를 계속 보내므로, 등록돼 있으면 '우리 하드웨어' 로 인정은 해야 한다.
CREATE TABLE IF NOT EXISTS beacons (
  tag_id TEXT PRIMARY KEY,
  -- 하드웨어 라벨 ('팔찌 12'). 배정된 사람 이름과 다르다
  label TEXT,
  registered_at INTEGER,
  -- 분실·고장으로 빼는 경우. 이력을 지우지 않으려고 삭제 대신 표시만 한다
  retired INTEGER DEFAULT 0
);

-- 배정 이력 — 방문마다 한 줄. released_at IS NULL 이면 지금 배정 중.
--
-- **배정마다 새 person_id 를 만든다.** 비콘을 돌려쓰기 때문이다 — 오전 환자와 오후 환자가
-- 같은 person_id 를 쓰면 presence_logs 가 person_id 기준이라 두 사람의 동선이 한 사람
-- 기록으로 이어붙는다. 그러면 '이 환자 얼마나 기다렸나' 에 남의 시간이 섞인다.
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT,
  person_id TEXT,
  -- 접수 시각 = 환자 대기시간 기산점
  assigned_at INTEGER,
  released_at INTEGER
);
-- 열린 배정 조회가 스캔마다 일어난다 (화면 노출 여부 판단)
CREATE INDEX IF NOT EXISTS idx_assign_open ON assignments(tag_id, released_at);
CREATE INDEX IF NOT EXISTS idx_assign_person ON assignments(person_id);

CREATE TABLE IF NOT EXISTS persons (
  person_id TEXT PRIMARY KEY, type TEXT, display_name TEXT,
  role TEXT, dept TEXT
);

CREATE TABLE IF NOT EXISTS presence_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT, person_id TEXT, zone_id TEXT,
  entered_at INTEGER, exited_at INTEGER, duration_sec INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_person ON presence_logs(person_id);
CREATE INDEX IF NOT EXISTS idx_logs_zone ON presence_logs(zone_id);

-- 운영자가 태그에 붙인 이름/메모 (tagId 대신 표시)
-- 환자용 화면 캐릭터 커스터마이징 (첫 진입 시 선택)
-- 태그 반납 시 지운다 — 다음 환자에게 이전 사람 캐릭터가 남으면 안 된다.
CREATE TABLE IF NOT EXISTS patient_profiles (
  person_id TEXT PRIMARY KEY,
  char_id TEXT,
  nickname TEXT,
  updated_at INTEGER
);

-- 방 안내 이력 — 안내 한 건당 한 줄 (발행 → 도착/해제).
--
-- **살아 있는 안내(화살표)는 여기 없다.** 그건 GuidanceStore 가 메모리로 들고 있고,
-- 재시작하면 사라지는 게 맞다. 이 표는 그 반대편 — "무슨 지시를 내렸고 어떻게 끝났나" 다.
--
-- ⚠️ 이 표가 DB 인 이유는 **알림톡** 이다. 외부로 나간 메시지는 서버 재시작으로 같이
--    사라져 주지 않는다. 안내를 메모리에만 두면 "사과 환자가 시술실 1로 이동중입니다" 를
--    보낸 뒤 재시작이 일어났을 때 도착 판정이 영영 안 뜨고, 메신저에는 **영원히 이동 중인
--    환자**가 남는다. 그래서 발행 사실을 먼저 여기 적고, 상태 전이를 여기서 확정한다.
--    (앞으로 붙일 발송함(outbox)은 이 표의 id 를 참조해 중복 발송을 막는다.)
CREATE TABLE IF NOT EXISTS navigation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id TEXT NOT NULL,
  -- 배정마다 새로 생기는 id. 비콘을 돌려쓰므로 tag_id 만으로는 사람을 못 가린다
  person_id TEXT,
  /* 발송된 알림 문구의 원본이라 **그 시점 이름을 박아 둔다**.
     persons.display_name 은 나중에 고쳐질 수 있는데(renameHolder), 이미 보낸 메시지의
     내용은 과거 사실이라 따라 바뀌면 안 된다. */
  person_name TEXT,
  -- 안내를 걸 때 있던 방 (복도·자리비움이면 NULL)
  from_zone TEXT,
  to_zone TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  arrived_at INTEGER,
  -- 어떤 사유로든 끝난 시각 (도착 포함)
  closed_at INTEGER,
  -- moving | arrived | cancelled | superseded | aborted
  status TEXT NOT NULL,
  -- 발행 → 도착까지 걸린 시간. 대기시간 분석의 원천
  travel_sec INTEGER
);
-- 진행 중인 안내 조회가 도착 판정마다 일어난다
CREATE INDEX IF NOT EXISTS idx_nav_open ON navigation_logs(tag_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_nav_person ON navigation_logs(person_id);
CREATE INDEX IF NOT EXISTS idx_nav_issued ON navigation_logs(issued_at);

CREATE TABLE IF NOT EXISTS tag_meta (
  tag_id TEXT PRIMARY KEY,
  name TEXT,
  memo TEXT,
  -- 직원 화면 왼쪽 목록의 그룹 (doctor/nurse/interpreter/patient/unassigned)
  tag_group TEXT,
  updated_at INTEGER
);

-- 직원이 화면에서 바로 남기는 버그 신고·개선 메모.
--
-- **왜 저장소가 아니라 DB 인가.** 신고하는 사람은 현장 직원이고, 이슈 트래커 계정이 없다.
-- 지금은 구두나 카톡으로 넘어와서 "언제 어느 화면이었는지" 가 늘 빠진 채로 도착한다.
-- 화면에서 바로 적게 하면 그 맥락(확대 배율·선택 비콘·추적 태그 수 등)을 사람이 적지
-- 않아도 같이 남길 수 있다 — `context` 열이 그것이다.
--
-- 내용 그대로가 원본이므로 수정하지 않는다. 처리 여부만 status 로 뒤집는다.
CREATE TABLE IF NOT EXISTS feedback_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- bug | idea | etc — 분류만 하고 판단은 사람이 한다
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 누가 남겼나 (선택). 안 적어도 받는 게 낫다 — 이름 칸이 필수면 그냥 말로 하고 만다
  author TEXT,
  /* 적을 때의 화면 상태 스냅샷. 사람이 적지 않아도 되는 부분을 자동으로 채운다 —
     "이 버그 언제 봤어요?" 를 되묻지 않으려고 있는 열이다. */
  context TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  -- open | done
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_open ON feedback_notes(status, created_at);
