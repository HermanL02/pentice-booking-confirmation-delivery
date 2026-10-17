import { Module } from '@nestjs/common';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

@Module({
  providers: [CorrelationIdMiddleware],
  exports: [CorrelationIdMiddleware],
})
export class CommonModule {}
