import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { recordAuditEvent, type AuditEvent } from './operator-audit.js';

@Injectable()
export class OperatorAuditLog {
  constructor(private readonly prisma: PrismaService) {}

  // For actions whose own writes are not a single transaction, such as batched maintenance.
  async record(event: AuditEvent): Promise<void> {
    await recordAuditEvent(this.prisma, event);
  }

  async recent(limit: number) {
    return this.prisma.operatorAuditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
