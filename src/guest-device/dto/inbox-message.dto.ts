import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class InboxMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() deliveryId!: string;
  @ApiPropertyOptional({ enum: ['confirmation', 'cancellation'] })
  @IsOptional()
  @IsIn(['confirmation', 'cancellation'])
  kind?: 'confirmation' | 'cancellation';
  @ApiProperty() @IsString() @IsNotEmpty() confirmationCode!: string;
  @ApiProperty() @IsString() @IsNotEmpty() reservationId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() guest!: string;
  @ApiProperty() @IsString() @IsNotEmpty() ackToken!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false })
  ackUrl!: string;
}
