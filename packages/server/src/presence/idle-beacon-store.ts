import type { ScanEvent } from '@meditracker/shared';

/**
 * 배정 안 된 비콘의 생사 확인용 최소 기록.
 *
 * **왜 필요한가.** 비콘은 전원이 늘 켜져 있어 창고에 있어도 신호를 계속 보낸다. 그 신호를
 * 존 판정까지 태우면 태그 100개분 연산이 상시로 도는데(서버가 CPU 한 코어를 다 쓴 전례가
 * 있다), 그렇다고 통째로 버리면 **배터리가 죽은 비콘을 꺼내 볼 때까지 모른다.**
 *
 * 그래서 판정·좌표·로그에는 안 넣고 여기에 "마지막으로 언제, 어느 게이트웨이가, 얼마나
 * 세게 들었나" 만 덮어쓴다. 태그당 객체 하나라 100개여도 무시할 만하고, 태그 목록에서
 * **"3일째 무신호"** 나 **"대충 어디쯤"** 을 보여줄 수 있다.
 *
 * 배정된 비콘은 여기 안 들어온다 — 그건 정식 파이프라인이 다룬다.
 */

export interface IdleSighting {
  tagId: string;
  lastSeen: number;
  /** 가장 세게 들은 게이트웨이 — 창고인지 딴 데 굴러다니는지 가늠용 */
  gatewayId: string;
  rssi: number;
}

export class IdleBeaconStore {
  private seen = new Map<string, IdleSighting>();

  /**
   * 스캔 한 건 반영. 같은 주기에 여러 게이트웨이가 들으면 **가장 센 것**만 남긴다 —
   * 마지막에 도착한 것을 쓰면 위치가 아니라 도착 순서를 기록하게 된다.
   */
  note(scan: ScanEvent): void {
    const prev = this.seen.get(scan.tagId);
    // 직전 기록이 같은 주기(2초 안)면 더 센 쪽을 남기고, 지났으면 새로 시작한다
    const sameSweep = prev && scan.timestamp - prev.lastSeen < 2000;
    if (sameSweep && prev!.rssi >= scan.rssi) {
      prev!.lastSeen = scan.timestamp;
      return;
    }
    this.seen.set(scan.tagId, {
      tagId: scan.tagId,
      lastSeen: scan.timestamp,
      gatewayId: scan.gatewayId,
      rssi: scan.rssi,
    });
  }

  get(tagId: string): IdleSighting | undefined {
    return this.seen.get(tagId);
  }

  all(): IdleSighting[] {
    return [...this.seen.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 배정되면 더는 유휴가 아니다 — 정식 파이프라인이 맡으므로 여기서 뺀다 */
  forget(tagId: string): void {
    this.seen.delete(tagId);
  }

  size(): number {
    return this.seen.size;
  }
}
