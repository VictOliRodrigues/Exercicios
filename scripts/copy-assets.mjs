import { cpSync } from 'node:fs';

// Arquivos que o tsc não copia: telas, CSS/JS do navegador, migrations e modelos para download.
const copies = [
  ['src/views', 'dist/src/views'],
  ['src/public', 'dist/src/public'],
  ['src/db/migrations', 'dist/src/db/migrations'],
  ['modelos', 'dist/modelos'],
];

for (const [from, to] of copies) cpSync(from, to, { recursive: true });
console.log('Arquivos copiados para dist/.');
