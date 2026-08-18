import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { AuthClaims, Guidance } from '@meditracker/shared';
import { verifyToken } from '../auth/jwt.js';
import type { PresenceService } from '../presence/presence-service.js';
import type { Db } from '../db/index.js';
import type { TagMetaStore } from '../presence/tag-meta-store.js';
import { registerPatientNamespace, type PatientBroadcast } from './patient-namespace.js';
import { registerStaffNamespace } from './staff-namespace.js';

export interface AuthedSocket extends Socket {
  claims: AuthClaims;
}

/** handshake.auth.token 의 JWT 검증 미들웨어 */
function jwtMiddleware(secret: string, requiredType: 'patient' | 'staff') {
  return (socket: Socket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const claims = token ? verifyToken(token, secret) : null;
    if (!claims) return next(new Error('unauthorized'));
    // 불변식 B-2: 환자/직원 namespace 물리 분리 — 타입 불일치 접속 거부
    if (claims.type !== requiredType) return next(new Error('forbidden'));
    (socket as AuthedSocket).claims = claims;
    next();
  };
}

export function createWsServer(
  httpServer: HttpServer,
  jwtSecret: string,
  presence: PresenceService,
  db: Db,
  tagMeta: TagMetaStore,
  /** 접속 시점에 이미 걸려 있는 방 안내 (화면을 새로고침해도 남아 있게) */
  guideOf: (tagId: string) => string | null,
  guidanceAll: () => Guidance[],
): { io: Server; patient: PatientBroadcast } {
  const io = new Server(httpServer, { cors: { origin: true } });

  const patientNs = io.of('/patient');
  patientNs.use(jwtMiddleware(jwtSecret, 'patient'));
  const patient = registerPatientNamespace(patientNs, presence, db, tagMeta, guideOf);

  const staffNs = io.of('/staff');
  staffNs.use(jwtMiddleware(jwtSecret, 'staff'));
  registerStaffNamespace(staffNs, presence, db, guidanceAll);

  /**
   * 관제(`/monitor`)도 직원 토큰을 요구한다 — 여기가 태그 위치·RSSI 전부가 나가는 통로다.
   *
   * HTML(`GET /monitor`)은 막지 않는다. 화면 파일은 비밀이 아니고, 그 페이지가 진입 핀을 물어
   * 토큰을 받은 다음 이 소켓에 붙는다. **막아야 하는 건 데이터고, 데이터는 여기로만 나간다.**
   * namespace 는 MonitorHub 가 만들지만 io.of() 는 같은 것을 돌려주므로 순서와 무관하다.
   */
  io.of('/monitor').use(jwtMiddleware(jwtSecret, 'staff'));

  return { io, patient };
}
