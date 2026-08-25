import { describe, it, expect } from 'vitest';
import { isErrorMetaName } from '../stremio-addon';

describe('isErrorMetaName', () => {
  it('flags AIOStreams error placeholders', () => {
    expect(isErrorMetaName('[❌] AIOStreams - Error - Trailer')).toBe(true);
    expect(isErrorMetaName('AIO Streams - Error')).toBe(true);
    expect(isErrorMetaName('AIOStreams - Error')).toBe(true);
    expect(isErrorMetaName('[❌] AIOStreams - Error')).toBe(true);
  });

  it('accepts real titles', () => {
    expect(isErrorMetaName('Inception')).toBe(false);
    expect(isErrorMetaName('The Error')).toBe(false);
    expect(isErrorMetaName('AIOStreams')).toBe(false);
    expect(isErrorMetaName('AIO Streams')).toBe(false);
    expect(isErrorMetaName('The Error of AIO')).toBe(false);
  });

  it('treats missing/empty names as unusable', () => {
    expect(isErrorMetaName(null)).toBe(true);
    expect(isErrorMetaName(undefined)).toBe(true);
    expect(isErrorMetaName('')).toBe(true);
    expect(isErrorMetaName('   ')).toBe(false);
  });
});
