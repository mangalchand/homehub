import { describe, expect, it } from 'vitest';
import { cn, initials, uuid } from '../utils';

describe('utils', () => {
  it('merges tailwind classes', () => {
    const hidden = false as boolean;
    expect(cn('p-2', 'p-4', hidden && 'hidden')).toBe('p-4');
  });
  it('computes initials', () => {
    expect(initials('Grandma Rosa')).toBe('GR');
    expect(initials('maya')).toBe('M');
  });
  it('creates RFC4122 v4 ids', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
