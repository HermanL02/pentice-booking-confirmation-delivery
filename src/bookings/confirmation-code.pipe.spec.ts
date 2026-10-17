import { BadRequestException } from '@nestjs/common';
import { ConfirmationCodePipe } from './confirmation-code.pipe';

describe('ConfirmationCodePipe', () => {
  const pipe = new ConfirmationCodePipe();

  it('lowercases A2B34 to a2b34', () => {
    expect(pipe.transform('A2B34')).toBe('a2b34');
  });

  it.each([
    ['rejects 4 chars', 'a2b3'],
    ['rejects 6 chars', 'a2b345'],
    ['rejects a2b-4', 'a2b-4'],
  ])('%s', (_name, input) => {
    expect(() => pipe.transform(input)).toThrow(BadRequestException);
  });
});
