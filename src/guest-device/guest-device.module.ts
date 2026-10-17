import { Module } from '@nestjs/common';
import { GuestDeviceController } from './guest-device.controller';
import { GuestDeviceService } from './guest-device.service';

@Module({
  controllers: [GuestDeviceController],
  providers: [
    { provide: GuestDeviceService, useFactory: () => new GuestDeviceService() },
  ],
})
export class GuestDeviceModule {}
