import { userInfo, hostname } from 'node:os';
import type { Prisma } from '../generated/prisma/client.js';

export interface AuditEvent {
  actor: string;
  // Dotted, lowercase: `merchant.created`, `api_key.revoked`, `outbox_job.requeued`, ...
  action: string;
  targetType: string;
  targetId: string;
  // Identifiers and outcome facts only; never key material or raw command arguments.
  details?: Prisma.InputJsonObject;
}

export const SYSTEM_ACTOR = 'system';

// Written inside the caller's transaction so an action and its audit record commit together.
export async function recordAuditEvent(
  db: Prisma.TransactionClient,
  event: AuditEvent,
): Promise<void> {
  await db.operatorAuditEvent.create({
    data: {
      actor: event.actor,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      details: event.details ?? {},
    },
  });
}

// Self-declared, so it identifies who ran a command for normal accountability, not for
// authentication: anyone able to run the CLI can also set PAYGUARD_OPERATOR.
export function resolveOperator(declared: string | undefined): string {
  if (declared) return declared;
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return `unknown@${hostname()}`;
  }
}
