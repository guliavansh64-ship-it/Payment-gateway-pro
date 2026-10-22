import type { PoolClient } from 'pg';
import { one, query } from '../db/pool';
import type { SessionRecord, User, UserRole } from '../domain/models';

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  password_hash: string | null;
  is_active: boolean;
  last_login_at: Date | null;
  failed_logins: number;
  locked_until: Date | null;
  created_at: Date;
};

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    failedLogins: row.failed_logins,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
  };
}

export async function findUserByEmail(
  email: string,
): Promise<{ user: User; passwordHash: string | null } | null> {
  const row = await one<UserRow>(
    `SELECT id, name, email, role, password_hash, is_active, last_login_at, failed_logins,
            locked_until, created_at
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return row ? { user: mapUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const row = await one<UserRow>(
    `SELECT id, name, email, role, password_hash, is_active, last_login_at, failed_logins,
            locked_until, created_at
       FROM users WHERE id = $1`,
    [id],
  );
  return row ? mapUser(row) : null;
}

export async function createUser(input: {
  name: string;
  email: string;
  role: UserRole;
  passwordHash: string | null;
}): Promise<User> {
  const row = await one<UserRow>(
    `INSERT INTO users (name, email, role, password_hash)
     VALUES ($1, lower($2), $3, $4)
     RETURNING id, name, email, role, password_hash, is_active, last_login_at, failed_logins, locked_until, created_at`,
    [input.name, input.email, input.role, input.passwordHash],
  );
  if (!row) throw new Error('Failed to create user');
  return mapUser(row);
}

export async function registerLoginSuccess(userId: string): Promise<void> {
  await query(
    'UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1',
    [userId],
  );
}

export async function registerLoginFailure(
  userId: string,
  maxFailures: number,
  lockMinutes: number,
): Promise<void> {
  await query(
    `UPDATE users
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2
                                THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE id = $1`,
    [userId, maxFailures, lockMinutes],
  );
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  ipHash: string;
  userAgentHash: string;
  expiresAt: Date;
}): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO user_sessions (user_id, token_hash, csrf_token_hash, ip_hash, user_agent_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.userId, input.tokenHash, input.csrfTokenHash, input.ipHash, input.userAgentHash, input.expiresAt],
  );
  if (!row) throw new Error('Failed to create session');
  return row.id;
}

export async function findSessionByTokenHash(
  tokenHash: string,
): Promise<{ session: SessionRecord; user: User } | null> {
  const row = await one<
    UserRow & {
      session_id: string;
      csrf_token_hash: string;
      elevated_until: Date | null;
      session_expires_at: Date;
      revoked_at: Date | null;
      ip_hash: string | null;
      user_agent_hash: string | null;
    }
  >(
    `SELECT s.id AS session_id, s.csrf_token_hash, s.elevated_until, s.expires_at AS session_expires_at,
            s.revoked_at, s.ip_hash, s.user_agent_hash,
            u.id, u.name, u.email, u.role, u.password_hash, u.is_active, u.last_login_at,
            u.failed_logins, u.locked_until, u.created_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  if (!row) return null;
  return {
    session: {
      id: row.session_id,
      userId: row.id,
      csrfTokenHash: row.csrf_token_hash,
      elevatedUntil: row.elevated_until,
      expiresAt: row.session_expires_at,
      revokedAt: row.revoked_at,
      ipHash: row.ip_hash,
      userAgentHash: row.user_agent_hash,
    },
    user: mapUser(row),
  };
}

export async function touchSession(sessionId: string): Promise<void> {
  await query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeSession(sessionId: string, client?: PoolClient): Promise<void> {
  const sql = 'UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL';
  if (client) await client.query(sql, [sessionId]);
  else await query(sql, [sessionId]);
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
}

export async function elevateSession(sessionId: string, minutes: number): Promise<void> {
  await query(
    `UPDATE user_sessions SET elevated_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
    [sessionId, minutes],
  );
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await query("DELETE FROM user_sessions WHERE expires_at < now() - interval '7 days'");
  return res.rowCount ?? 0;
}

export async function listUsers(limit = 100): Promise<User[]> {
  const res = await query<UserRow>(
    `SELECT id, name, email, role, password_hash, is_active, last_login_at, failed_logins,
            locked_until, created_at
       FROM users ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map(mapUser);
}
