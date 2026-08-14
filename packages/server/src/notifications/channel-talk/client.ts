/**
 * 채널톡(채널 웍스) Open API 클라이언트 — 알림 아웃바운드 전용.
 *
 * 인증은 채널 데스크에서 발급한 Access Key/Secret 두 헤더가 전부다. 버전은 날짜
 * 문자열(Channel-Version)로 고정한다 — 안 보내면 채널 설정의 기본 버전이 적용되는데,
 * 그건 채널 쪽에서 움직일 수 있는 값이라 어느 날 다른 스키마로 응답이 올 수 있다.
 *
 * 여기 함수들은 **절대 throw 하지 않는다.** 알림은 곁가지 기능이라 채널톡 장애·키 오류가
 * 호출부(라우터, 나중에는 브로드캐스트 루프)로 전파되면 주객전도다. 실패는 {ok:false}다.
 *
 * 스펙 출처: https://api-doc.channel.works (openapi 2026-06-01)
 */
import { SERVER_CONFIG } from '../../config/index.js';

const BASE = 'https://api.channel.io';
const CHANNEL_VERSION = '2026-06-01';
const TIMEOUT_MS = 6000;

export interface ChannelTalkResult {
  ok: boolean;
  /** HTTP 상태. 요청이 네트워크 단계에서 실패하면 0 */
  status: number;
  body: unknown;
}

export function channelTalkConfigured(): boolean {
  const { accessKey, accessSecret } = SERVER_CONFIG.channelTalk;
  return accessKey.length > 0 && accessSecret.length > 0;
}

/** text 블록은 인라인 마크업을 해석한다 — 사용자 입력이 태그로 오해되지 않게 이스케이프 */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 팀챗 멘션 마크업. text 블록 안에서만 의미가 있다 — plainText 에 넣으면 문자 그대로 보인다 */
export function mentionMarkup(managerId: string, managerName: string): string {
  return `<link type="manager" value="${escapeMarkup(managerId)}">@${escapeMarkup(managerName)}</link>`;
}

/** 그룹은 숫자 ID 와 이름 둘 다 허용 — 경로가 다르다 (이름 쪽은 @ 접두 + 인코딩) */
export function groupMessagePath(group: string): string {
  return /^\d+$/.test(group)
    ? `/open/groups/${group}/messages`
    : `/open/groups/@${encodeURIComponent(group)}/messages`;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  jsonBody?: unknown,
): Promise<ChannelTalkResult> {
  if (!channelTalkConfigured()) {
    return {
      ok: false,
      status: 0,
      body: { error: 'CHANNELTALK_ACCESS_KEY/SECRET 미설정 — packages/server/.env 참고' },
    };
  }
  const { accessKey, accessSecret } = SERVER_CONFIG.channelTalk;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'x-access-key': accessKey,
        'x-access-secret': accessSecret,
        'Channel-Version': CHANNEL_VERSION,
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = text;
    // 에러 페이지가 HTML 로 올 때도 있어서 JSON 파싱 실패는 원문 그대로 넘긴다
    try {
      body = JSON.parse(text);
    } catch {}
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } };
  }
}

/** 매니저 목록 — 테스트 페이지에서 멘션·공지 대상을 고르는 데 쓴다 */
export function listManagers(): Promise<ChannelTalkResult> {
  return request('GET', '/open/managers?limit=100');
}

/** 팀챗 그룹 목록 */
export function listGroups(): Promise<ChannelTalkResult> {
  return request('GET', '/open/groups?limit=100');
}

/** 팀챗 그룹에 봇 메시지. markupText 는 마크업 문자열 — 멘션은 mentionMarkup() 으로 만든다 */
export function sendGroupMessage(group: string, markupText: string): Promise<ChannelTalkResult> {
  const botName = encodeURIComponent(SERVER_CONFIG.channelTalk.botName);
  return request('POST', `${groupMessagePath(group)}?botName=${botName}`, {
    blocks: [{ type: 'text', value: markupText }],
  });
}

/**
 * 특정 매니저에게 다이렉트 공지 — 그룹 없이 그 사람의 알림함으로 바로 간다.
 * 팀챗 DM 을 봇이 여는 API 는 없어서, 1:1 성격의 알림은 이걸 쓴다.
 */
export function announceToManager(managerId: string, plainText: string): Promise<ChannelTalkResult> {
  const botName = encodeURIComponent(SERVER_CONFIG.channelTalk.botName);
  const ids = encodeURIComponent(managerId);
  return request('POST', `/open/announcements/announce?managerIds=${ids}&botName=${botName}`, {
    plainText,
  });
}
