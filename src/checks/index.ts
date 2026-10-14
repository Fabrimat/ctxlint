import type { Check } from '../types.js';
import { commandsCheck } from './commands.js';
import { pathsCheck } from './paths.js';
import { scriptsCheck } from './scripts.js';

export const checks: Check[] = [pathsCheck, scriptsCheck, commandsCheck];
