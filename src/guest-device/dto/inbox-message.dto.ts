import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class InboxMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() deliveryId!: string;
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
