import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { AuthClaims } from '@meditracker/shared';
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
): { io: Server; patient: PatientBroadcast } {
  const io = new Server(httpServer, { cors: { origin: true } });

  const patientNs = io.of('/patient');
  patientNs.use(jwtMiddleware(jwtSecret, 'patient'));
  const patient = registerPatientNamespace(patientNs, presence, db, tagMeta);

  const staffNs = io.of('/staff');
  staffNs.use(jwtMiddleware(jwtSecret, 'staff'));
  registerStaffNamespace(staffNs, presence, db);

  return { io, patient };
}
