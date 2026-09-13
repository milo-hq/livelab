import { randomUUID, createHash } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** Deterministic demo user id so the same display name keeps its wallet across reloads. */
export const userIdFor = (name: string, role: string) =>
  'u_' + createHash('sha1').update(`${role}:${name.toLowerCase()}`).digest('hex').slice(0, 12);
