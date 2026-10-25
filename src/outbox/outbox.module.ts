import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxStore } from './outbox-store.js';

@Module({
  imports: [DatabaseModule],
  providers: [OutboxStore],
  exports: [OutboxStore],
})
export class OutboxModule {}
