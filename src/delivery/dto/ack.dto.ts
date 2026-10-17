import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class AckDto {
  @ApiProperty({ minLength: 64, maxLength: 64 })
  @IsString()
  @Length(64, 64)
  ackToken!: string;
}
