-- 설계서 9. DB 스키마 (SQLite)

CREATE TABLE IF NOT EXISTS zones (
  zone_id TEXT PRIMARY KEY, name TEXT, type TEXT, category TEXT,
  tile_x INTEGER, tile_y INTEGER, social_enabled INTEGER
);

CREATE TABLE IF NOT EXISTS gateways (
  gateway_id TEXT PRIMARY KEY, zone_id TEXT, label TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  tag_id TEXT PRIMARY KEY, person_id TEXT, person_type TEXT,
  assigned_at INTEGER, active INTEGER
);

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
CREATE TABLE IF NOT EXISTS tag_meta (
  tag_id TEXT PRIMARY KEY,
  name TEXT,
  memo TEXT,
  -- 직원 화면 왼쪽 목록의 그룹 (doctor/nurse/interpreter/patient/unassigned)
  tag_group TEXT,
  updated_at INTEGER
);
