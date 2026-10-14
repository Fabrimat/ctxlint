import type { Check } from '../types.js';
import { commandsCheck } from './commands.js';
import { pathsCheck } from './paths.js';
import { scriptsCheck } from './scripts.js';
import { snippetsCheck } from './snippets.js';
import { symbolsCheck } from './symbols.js';
import { versionsCheck } from './versions.js';

export const checks: Check[] = [
  pathsCheck,
  scriptsCheck,
  commandsCheck,
  symbolsCheck,
  snippetsCheck,
  versionsCheck,
];
