import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { OutboxRecord } from '../../storage/storage.port';

export class ListDeliveriesQuery {
  @ApiPropertyOptional({ enum: ['pending', 'acked', 'cancelled'] })
  @IsOptional()
  @IsIn(['pending', 'acked', 'cancelled'])
  status?: OutboxRecord['status'];

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  attention?: boolean;
}
