import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DecryptionError } from '../../src/crypto/cipher.js';
import { createFileStore, type FileStore } from '../../src/crypto/file-store.js';
import { createCryptoService } from '../../src/crypto/index.js';
import { createKeyring } from '../../src/crypto/keys.js';

const CONTENT = Buffer.from('# Simulado\n\n## Questão 1\nQual é a capital da Austrália?\n');

describe('armazenamento de arquivos criptografados', () => {
  let root: string;
  let store: FileStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'simulados-files-'));
    store = createFileStore(
      root,
      createCryptoService(createKeyring(randomBytes(32).toString('base64'), 1)),
    );
  });

  it('grava e lê de volta o mesmo conteúdo', async () => {
    const key = await store.save(CONTENT);
    expect((await store.read(key)).equals(CONTENT)).toBe(true);
  });

  it('o arquivo no disco é ilegível e tem nome aleatório', async () => {
    const key = await store.save(CONTENT);
    const files = await readdir(path.join(root, 'banks'));
    expect(files).toEqual([`${key}.enc`]);
    const raw = await readFile(path.join(root, 'banks', files[0]!));
    expect(raw.includes(Buffer.from('Austrália'))).toBe(false);
    expect(raw.includes(Buffer.from('Simulado'))).toBe(false);
  });

  it('detecta arquivo adulterado', async () => {
    const key = await store.save(CONTENT);
    const file = path.join(root, 'banks', `${key}.enc`);
    const raw = await readFile(file);
    raw[raw.length - 1]! ^= 0xff;
    await writeFile(file, raw);
    await expect(store.read(key)).rejects.toThrow(DecryptionError);
  });

  it('não aceita arquivo trocado de nome (AAD amarra o conteúdo ao nome)', async () => {
    const first = await store.save(CONTENT);
    const second = await store.save(Buffer.from('outro'));
    await writeFile(
      path.join(root, 'banks', `${second}.enc`),
      await readFile(path.join(root, 'banks', `${first}.enc`)),
    );
    await expect(store.read(second)).rejects.toThrow(DecryptionError);
  });

  it('recusa chave de arquivo inválida (sem path traversal)', async () => {
    await expect(store.read('../../etc/passwd')).rejects.toThrow('inválida');
  });

  it('remove o arquivo', async () => {
    const key = await store.save(CONTENT);
    await store.remove(key);
    expect(await readdir(path.join(root, 'banks'))).toEqual([]);
  });
});
