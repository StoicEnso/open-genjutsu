const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Ciphertext only. Electron owns encryption; never fall back to plaintext storage. */
function createCredentialStore(safeStorage, userData) {
  const directory = path.join(userData, 'credentials');
  const filename = path.join(directory, 'comfy-router.encrypted');
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Encrypted credential storage is unavailable. Use a session-only key.');
    }
  }
  return {
    async read() {
      requireEncryption();
      let handle;
      try {
        handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const information = await handle.stat();
        if (!information.isFile() || information.size > 65536) throw new Error('Invalid encrypted credential file.');
        return safeStorage.decryptString(await handle.readFile());
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new Error('Could not unlock the saved provider key. Reconnect with a session-only key.');
      } finally { await handle?.close(); }
    },
    async write(secret) {
      requireEncryption();
      if (typeof secret !== 'string' || !secret.length || secret.length > 16384) throw new Error('Invalid provider credential.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const information = await fs.lstat(directory);
      if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('Invalid credential directory.');
      await fs.chmod(directory, 0o700);
      const temporary = path.join(directory, `.credential-${randomUUID()}.tmp`);
      try {
        const encrypted = safeStorage.encryptString(secret);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, filename);
      } catch {
        throw new Error('Could not save the encrypted provider key. Use a session-only key.');
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    },
    async clear() { await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw new Error('Could not remove the saved provider key.'); }); },
  };
}
module.exports = { createCredentialStore };
