import { randomInt } from 'node:crypto';

export const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const CODE_LENGTH = 5;
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export class CodeCollisionError extends Error {
  constructor(maxTries: number) {
    super(`could not generate a unique confirmation code in ${maxTries} tries`);
    this.name = 'CodeCollisionError';
  }
}

/** `random(max)` returns an integer in `[0, max)`. */
export function generateCode(
  random: (max: number) => number = randomInt,
): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return code;
}

export function generateUniqueCode(
  taken: (code: string) => boolean,
  maxTries = 5,
  random: (max: number) => number = randomInt,
): string {
  for (let i = 0; i < maxTries; i++) {
    const code = generateCode(random);
    if (!taken(code)) return code;
  }
  throw new CodeCollisionError(maxTries);
}
