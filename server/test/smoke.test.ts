import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';

describe('scaffold', () => {
  it('runs typescript tests', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
