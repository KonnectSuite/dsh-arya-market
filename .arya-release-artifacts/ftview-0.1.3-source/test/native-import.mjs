import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { __internals, importStatus } from '../index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ftview-import-'));
  const pkg = join(root, '.ftview', 'changes', 'test'); mkdirSync(pkg, { recursive: true });
  const receipt = join(root, '.ftview', 'synthetic-receipt.json');
  writeFileSync(receipt, JSON.stringify({ application: 'AryaFTV_Test', exit_code: 0, reexport_matches: true }));
  // Only this mock adapter uses synthetic receipts; never exercises a vendor utility.
  writeFileSync(join(root, '.ftview', 'native-capabilities.json'), JSON.stringify({ edition: 'ME', marketing_version: 16, utility_sha256: 'fixture', validated_categories: ['Graphics;Displays:xml'], probe_receipt: receipt, probe_receipt_sha256: createHash('sha256').update(readFileSync(receipt)).digest('hex') }));
  writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ files: [{ category: 'Graphics;Displays', payload: join(pkg, 'AryaPilot.xml') }] }));
  const plan = { application: 'AryaFTV_Test', project_path: '/synthetic', component_list: join(pkg, 'components.xml'), package: pkg, overwrite: false };
  return { root, pkg, plan, services: { engine: async () => plan, discover: async () => ({ utilities: { 'SEAddComponent.exe': { path: 'never-invoked-vendor.exe', sha256: 'fixture' } } }) } };
}

test('vendor log errors override an exit code of zero', () => {
  assert.match(importStatus({ code: 0, expired: false }, 'An internal error has occurred during import.\nProgram completed with ERRORS.'), /failed_import_vendor_log/);
  assert.match(importStatus({ code: 0, expired: false }, null), /log_missing/);
});

test('partial native import retains failure and never auto-retries', async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await __internals.applyChange({ package: f.pkg, mode: 'execute' }, f.root, { ...f.services, runProcess: async (_exe, args) => {
      calls++; assert.deepEqual(args.slice(0, 3), ['AryaFTV_Test', 'ME', '/']);
      return { code: 1, stdout: '', stderr: 'second component failed', expired: false, overflow: false };
    } });
    assert.equal(calls, 1); assert.match(result.status, /partial_or_failed/);
    assert.equal(JSON.parse(readFileSync(join(f.pkg, 'apply-result.json'), 'utf8')).exit_code, 1);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('stale baseline after app lock refuses before utility input', async () => {
  const f = fixture(); let checks = 0, calls = 0;
  try {
    await assert.rejects(__internals.applyChange({ package: f.pkg, mode: 'execute' }, f.root, { ...f.services,
      engine: async () => { if (++checks === 2) throw Error('STALE_NATIVE_BASELINE'); return f.plan; },
      runProcess: async () => { calls++; throw Error('must not invoke'); } }), /STALE_NATIVE/);
    assert.equal(calls, 0);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('utility update invalidates prior category qualification', async () => {
  const f = fixture();
  try {
    await assert.rejects(__internals.applyChange({ package: f.pkg, mode: 'execute' }, f.root, { ...f.services,
      discover: async () => ({ utilities: { 'SEAddComponent.exe': { path: 'never-invoked.exe', sha256: 'new-version' } } }) }), /VERSION_MISMATCH/);
  } finally { rmSync(f.root, { recursive: true }); }
});
