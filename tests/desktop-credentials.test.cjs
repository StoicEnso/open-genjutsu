const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('../desktop/credentials.cjs');
const encryptedFake = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value.split('').reverse().join('')),
  decryptString: value => value.toString().split('').reverse().join(''),
};
test('desktop keeps only ciphertext in a restricted file, replaces and removes it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'og-credentials-'));
  try {
    const credentials = createCredentialStore(encryptedFake, directory);
    const filename = path.join(directory, 'credentials/comfy-router.encrypted');
    assert.equal(await credentials.read(), undefined);
    await credentials.write('test-only-provider-secret');
    assert.equal(await credentials.read(), 'test-only-provider-secret');
    assert.ok(!(await fs.readFile(filename)).includes(Buffer.from('test-only-provider-secret')));
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
    await credentials.write('replacement-secret');
    assert.equal(await credentials.read(), 'replacement-secret');
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ['comfy-router.encrypted']);
    await credentials.clear();
    assert.equal(await credentials.read(), undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('desktop refuses unavailable or plaintext-only encryption without writing a key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'og-credentials-'));
  try {
    for (const storage of [{...encryptedFake, isEncryptionAvailable: () => false}, {...encryptedFake, getSelectedStorageBackend: () => 'basic_text'}]) {
      const credentials = createCredentialStore(storage, directory);
      await assert.rejects(credentials.write('test-only-provider-secret'), /session-only/);
      await assert.rejects(credentials.read(), /session-only/);
    }
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('desktop refuses a symlink credential directory and never writes into its target', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'og-credentials-'));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'og-credentials-target-'));
  try {
    await fs.symlink(target, path.join(directory, 'credentials'));
    await assert.rejects(createCredentialStore(encryptedFake, directory).write('test-only-provider-secret'), /directory/);
    assert.deepEqual(await fs.readdir(target), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); }
});
