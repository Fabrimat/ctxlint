// Run with `pnpm build && pnpm schema`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSchemas } from '../dist/schema/index.js';

const dir = join(import.meta.dirname, '../schema');
mkdirSync(dir, { recursive: true });
for (const [file, text] of Object.entries(generateSchemas())) writeFileSync(join(dir, file), text);
