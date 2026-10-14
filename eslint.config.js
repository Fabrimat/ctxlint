import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'test/fixtures'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
);
