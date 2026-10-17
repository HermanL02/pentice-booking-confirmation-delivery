import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getRoot(): { service: string } {
    return { service: 'booking-confirmation-delivery' };
  }
}
