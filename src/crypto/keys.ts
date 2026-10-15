import { hkdfSync } from 'node:crypto';

/** Subchaves derivadas da chave mestra, uma para cada uso. */
export interface KeySet {
  db: Buffer;
  files: Buffer;
  index: Buffer;
}

export interface Keyring {
  currentVersion: number;
  get(version: number): KeySet;
}

export function deriveKeySet(master: Buffer): KeySet {
  if (master.length !== 32) throw new Error('A chave mestra precisa ter 32 bytes');
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return {
    db: derive('simulados/db'),
    files: derive('simulados/files'),
    index: derive('simulados/index'),
  };
}

/** Por enquanto existe uma única versão de chave; o byte de versão deixa a rotação preparada. */
export function createKeyring(masterBase64: string, version: number): Keyring {
  const keys = new Map([[version, deriveKeySet(Buffer.from(masterBase64, 'base64'))]]);
  return {
    currentVersion: version,
    get(requested) {
      const keySet = keys.get(requested);
      if (!keySet) throw new Error(`Chave de criptografia da versão ${requested} não configurada`);
      return keySet;
    },
  };
}
