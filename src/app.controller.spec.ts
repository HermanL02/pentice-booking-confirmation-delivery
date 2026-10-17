import { Test } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  it('returns the service name from getRoot', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    const controller = moduleRef.get(AppController);

    expect(controller.getRoot()).toEqual({
      service: 'booking-confirmation-delivery',
    });
  });
});
