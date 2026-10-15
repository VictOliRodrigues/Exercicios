import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from './index.js';

export interface FileStore {
  ensureReady(): Promise<void>;
  /** Cifra e grava o conteúdo com um nome aleatório. Devolve a chave do arquivo. */
  save(content: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createFileStore(root: string, crypto: CryptoService): FileStore {
  const directory = path.resolve(root, 'banks');

  const fileFor = (storageKey: string) => {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error('Chave de arquivo inválida');
    return path.join(directory, `${storageKey}.enc`);
  };

  return {
    async ensureReady() {
      await mkdir(directory, { recursive: true });
    },
    async save(content) {
      await mkdir(directory, { recursive: true });
      const storageKey = uuidv7();
      const target = fileFor(storageKey);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, crypto.encryptFile(content, storageKey), { flag: 'wx' });
      await rename(temporary, target);
      return storageKey;
    },
    async read(storageKey) {
      return crypto.decryptFile(await readFile(fileFor(storageKey)), storageKey);
    },
    async remove(storageKey) {
      await rm(fileFor(storageKey), { force: true });
    },
  };
}
