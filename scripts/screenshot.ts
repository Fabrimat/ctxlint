// Renders a real colored run of `ctxtruth check` on the drift fixture as an SVG terminal shot:
// pnpm build && node scripts/screenshot.ts > media/drift-run.svg
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
/* eslint-disable no-control-regex -- parsing ANSI escape sequences is the point */

const root = join(import.meta.dirname, '..');
let out: string;
try {
  out = execFileSync('node', [join(root, 'dist/cli.js'), 'check'], {
    cwd: join(root, 'test/fixtures/drift'),
    env: { ...process.env, FORCE_COLOR: '1', CTXTRUTH_FORMAT: 'text' },
    encoding: 'utf8',
  });
} catch (err) {
  // Exit code 1 means findings, which is the point of the shot.
  out = (err as { stdout: string }).stdout;
}
out = out.replace(/\d+ ms/, '312 ms');

const COLORS: Record<string, string> = {
  '31': '#ff6b6b',
  '32': '#5fd38d',
  '33': '#f5c453',
  '36': '#5ccfe6',
  '90': '#7f8c98',
  '2': '#7f8c98',
};
const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const lines = ['$ ctxtruth check', ...out.trimEnd().split('\n')];
const charW = 8.4;
const lineH = 19;
const width =
  Math.ceil(Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length)) * charW) + 40;
const height = lines.length * lineH + 60;

const rows = lines.map((line, i) => {
  let color: string | undefined;
  let bold = false;
  const spans: string[] = [];
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (sgr) {
      for (const code of (sgr[1] || '0').split(';')) {
        if (code === '0' || code === '39' || code === '22') {
          if (code !== '22') color = undefined;
          if (code !== '39') bold = false;
        } else if (code === '1') bold = true;
        else if (COLORS[code]) color = COLORS[code];
      }
    } else if (part) {
      const attrs = `${color ? ` fill="${color}"` : ''}${bold ? ' font-weight="700"' : ''}`;
      spans.push(`<tspan${attrs}>${escape(part)}</tspan>`);
    }
  }
  const prompt = i === 0 ? ' fill="#9aa5b1"' : '';
  return `<text x="20" y="${48 + i * lineH}" xml:space="preserve"${prompt}>${spans.join('')}</text>`;
});

process.stdout
  .write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ctxtruth check output on a repository with stale docs">
<rect width="100%" height="100%" rx="8" fill="#1e2329"/>
<circle cx="20" cy="16" r="5" fill="#ff5f57"/><circle cx="36" cy="16" r="5" fill="#febc2e"/><circle cx="52" cy="16" r="5" fill="#28c840"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" fill="#e6e6e6">
${rows.join('\n')}
</g>
</svg>
`);
