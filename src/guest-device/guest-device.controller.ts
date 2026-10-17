import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { DeviceStatusDto } from './dto/device-status.dto';
import { InboxMessageDto } from './dto/inbox-message.dto';
import { GuestDeviceService } from './guest-device.service';

@ApiTags('guest-device')
@Controller('guest-device')
export class GuestDeviceController {
  constructor(private readonly service: GuestDeviceService) {}

  @Post('inbox')
  @HttpCode(200)
  @ApiResponse({ status: 200, description: 'Message handled' })
  @ApiResponse({ status: 503, description: 'Guest device is offline' })
  receive(@Body() dto: InboxMessageDto): { result: string } {
    const result = this.service.receive(dto);
    if (result === 'offline') {
      throw new ServiceUnavailableException('guest device is offline');
    }
    if (result === 'received' || result === 'duplicate') {
      void this.service.acknowledge(dto.ackUrl, dto.ackToken);
    }
    return { result };
  }

  @Put('status')
  setStatus(@Body() dto: DeviceStatusDto): {
    online: boolean;
    dropRate: number;
  } {
    this.service.setStatus(dto);
    return this.service.status();
  }

  @Get('inbox')
  inbox(): { items: ReturnType<GuestDeviceService['inbox']> } {
    return { items: this.service.inbox() };
  }

  @Delete('inbox')
  @HttpCode(204)
  reset(): void {
    this.service.reset();
  }
}
