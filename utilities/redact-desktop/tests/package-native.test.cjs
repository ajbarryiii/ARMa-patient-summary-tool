"use strict";
// Contract: verifyNativeBinary(file, {platform, arch}) accepts only the requested
// executable platform/CPU. verifyApplication defaults to Windows x64 and accepts
// the same explicit target for Mac; all existing payload restrictions apply.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { verifyNativeBinary } = require('../scripts/windows-package.cjs');
test('native packaging rejects wrong CPU, platform and truncated binaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-native-'));
  try {
    const file = path.join(dir, 'native');
    const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x100000c, 4);
    await fs.writeFile(file, macho);
    await verifyNativeBinary(file, { platform: 'darwin', arch: 'arm64' });
    await assert.rejects(verifyNativeBinary(file, { platform: 'darwin', arch: 'x64' }));
    await assert.rejects(verifyNativeBinary(file, { platform: 'win32', arch: 'x64' }));
    macho.writeUInt32LE(0x1000007, 4); await fs.writeFile(file, macho);
    await verifyNativeBinary(file, { platform: 'darwin', arch: 'x64' });
    await fs.writeFile(file, Buffer.from([0xcf, 0xfa]));
    await assert.rejects(verifyNativeBinary(file, { platform: 'darwin', arch: 'arm64' }));
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});
