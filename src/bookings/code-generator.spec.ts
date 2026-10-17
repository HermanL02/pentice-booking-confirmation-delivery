import {
  CODE_ALPHABET,
  CODE_LENGTH,
  CODE_PATTERN,
  CodeCollisionError,
  generateCode,
  generateUniqueCode,
} from './code-generator';

describe('code generator', () => {
  it('produces 5 chars from the alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();

      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(CODE_PATTERN);
      for (const ch of code) {
        expect(CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('uses the injected random', () => {
    expect(generateCode(() => 0)).toBe('aaaaa');
  });

  it('retries on collision then succeeds', () => {
    let calls = 0;
    const taken = () => ++calls <= 4;

    const code = generateUniqueCode(taken);

    expect(code).toMatch(CODE_PATTERN);
    expect(calls).toBe(5);
  });

  it('throws CodeCollisionError after maxTries', () => {
    const taken = jest.fn(() => true);

    expect(() => generateUniqueCode(taken, 3)).toThrow(CodeCollisionError);
    expect(taken).toHaveBeenCalledTimes(3);
  });
});
