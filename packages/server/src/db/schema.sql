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

CREATE TABLE IF NOT EXISTS tag_meta (
  tag_id TEXT PRIMARY KEY,
  name TEXT,
  memo TEXT,
  -- 직원 화면 왼쪽 목록의 그룹 (doctor/nurse/interpreter/patient/unassigned)
  tag_group TEXT,
  updated_at INTEGER
);
