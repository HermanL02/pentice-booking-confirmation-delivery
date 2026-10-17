import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { CODE_PATTERN } from './code-generator';

@Injectable()
export class ConfirmationCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const code = typeof value === 'string' ? value.toLowerCase() : '';
    if (!CODE_PATTERN.test(code)) {
      throw new BadRequestException(
        'confirmation code must be 5 lowercase alphanumeric characters',
      );
    }
    return code;
  }
}
