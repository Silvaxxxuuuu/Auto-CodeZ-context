import { describe, expect, it } from 'vitest';
import { ComputerContextRuntime } from '../src/agent/computer-context';

describe('ComputerContextRuntime', () => {
  it('exposes stable local computer context without reading arbitrary file contents', () => {
    const context = new ComputerContextRuntime().build();

    expect(context).toContain('Local computer context:');
    expect(context).toContain(`User: `);
    expect(context).toContain('Home:');
    expect(context).toContain('Drives:');
    expect(context).not.toContain('password');
  });
});
