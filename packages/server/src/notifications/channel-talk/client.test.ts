import { describe, expect, it } from 'vitest';
import { escapeMarkup, groupMessagePath, mentionMarkup } from './client.js';

describe('channel-talk client (순수 함수)', () => {
  it('그룹 경로 — 숫자면 ID, 아니면 @이름 (한글은 인코딩)', () => {
    expect(groupMessagePath('123456')).toBe('/open/groups/123456/messages');
    expect(groupMessagePath('ops-alert')).toBe('/open/groups/@ops-alert/messages');
    expect(groupMessagePath('관제 알림')).toBe(
      `/open/groups/@${encodeURIComponent('관제 알림')}/messages`,
    );
  });

  it('멘션 마크업 — text 블록의 link 태그', () => {
    expect(mentionMarkup('98765', '홍길동')).toBe(
      '<link type="manager" value="98765">@홍길동</link>',
    );
  });

  it('사용자 입력의 꺾쇠·앰퍼샌드는 마크업으로 오해되지 않게 이스케이프', () => {
    expect(escapeMarkup('3번 <진료실> & 대기')).toBe('3번 &lt;진료실&gt; &amp; 대기');
    // 이름에 태그를 넣어도 멘션 구조가 깨지지 않는다
    expect(mentionMarkup('1', 'a<b>c')).toBe('<link type="manager" value="1">@a&lt;b&gt;c</link>');
  });
});
