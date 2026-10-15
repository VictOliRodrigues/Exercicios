import { randomBytes } from 'node:crypto';

console.log('# Copie para o .env (ou para as variáveis de ambiente do Coolify).');
console.log('# GUARDE A ENCRYPTION_KEY FORA DO SERVIDOR: sem ela, os dados são irrecuperáveis.');
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
