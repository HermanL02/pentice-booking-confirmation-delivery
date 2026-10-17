import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateBookingDto {
  @ApiProperty({ example: 'R123', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  reservationId!: string;

  @ApiProperty({ example: 'ana@example.com', maxLength: 256 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  guest!: string;
}
