import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recognizeImageTextWindows } from '../src/ai/windows-ocr';

const execFileAsync = promisify(execFile);

const FIXTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$path = $env:AUTO_CODEZ_OCR_FIXTURE
$bitmap = [System.Drawing.Bitmap]::new(900,280)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(12,16,22))
$font = [System.Drawing.Font]::new('Consolas',[single]34,[System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$graphics.DrawString('AUTO CODEZ OCR TEST',$font,$brush,35,35)
$graphics.DrawString('STATUS READY   VALUE 42',$font,$brush,35,105)
$graphics.DrawString('ERRORS 0   FILES 17',$font,$brush,35,175)
$bitmap.Save($path,[System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
$font.Dispose()
$brush.Dispose()
`;

test('production Windows OCR helper reads a generated dense screenshot', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-ocr-'));
  const imagePath = path.join(root, 'fixture.png');
  try {
    const encoded = Buffer.from(FIXTURE_SCRIPT, 'utf16le').toString('base64');
    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], {
      windowsHide: true,
      env: { ...process.env, AUTO_CODEZ_OCR_FIXTURE: imagePath },
      timeout: 20_000,
    });

    const text = await recognizeImageTextWindows(imagePath);
    assert.match(text, /AUTO\s+CODEZ/i);
    assert.match(text, /READY/i);
    assert.match(text, /42/);
    assert.match(text, /17/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
