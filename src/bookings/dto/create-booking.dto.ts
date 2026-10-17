import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Rejects ids that cannot be stored as own keys of a plain-object map. */
export const SAFE_KEY = /^(?!__proto__$)(?!constructor$)(?!prototype$)/;

export class CreateBookingDto {
  @ApiProperty({ example: 'R123', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(SAFE_KEY, {
    message:
      'reservationId must not be a reserved property name (__proto__, constructor, prototype)',
  })
  reservationId!: string;

  @ApiProperty({ example: 'ana@example.com', maxLength: 256 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  guest!: string;
}
