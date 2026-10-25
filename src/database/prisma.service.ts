import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { EnvironmentVariables } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';

// No eager $connect: the pg pool connects on first query, so the API boots while
// PostgreSQL is down and /health reports 503 instead of the process crash-looping.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnApplicationShutdown
{
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  // The last shutdown phase, so in-flight work stopped in earlier phases can still write.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
