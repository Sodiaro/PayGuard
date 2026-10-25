import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OperatorAuditLog } from './operator-audit-log.js';

@Module({
  imports: [DatabaseModule],
  providers: [OperatorAuditLog],
  exports: [OperatorAuditLog],
})
export class AuditModule {}
