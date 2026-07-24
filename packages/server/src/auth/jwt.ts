import jwt from 'jsonwebtoken';
import type { AuthClaims } from '@meditracker/shared';

export function signToken(claims: AuthClaims, secret: string, expiresIn = '12h'): string {
  return jwt.sign(claims, secret, { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string, secret: string): AuthClaims | null {
  try {
    return jwt.verify(token, secret) as AuthClaims;
  } catch {
    return null;
  }
}
