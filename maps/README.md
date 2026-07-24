# maps/

강남 고트의원 6F 평면도 기반 Tiled 타일맵 (설계서 8).

## 제작 절차

1. [Tiled](https://www.mapeditor.org/) 에디터 설치
2. 병원 평면도 이미지를 바탕 레이어로 깔고 타일맵 제작
3. 각 존을 타일 영역(Object Layer)으로 정의 — `zoneId` 커스텀 속성 부여
4. `.tmj` (JSON) 포맷으로 이 폴더에 저장 → `floor6.tmj`
5. `packages/server/src/config/zones.json` 의 `tilePosition` 과 매핑 확인

## 파일

| 파일 | 설명 |
|---|---|
| `floor6.tmj` | (예정) 6층 평면도 타일맵 |
| `tileset.png` | (예정) 타일셋 이미지 |
