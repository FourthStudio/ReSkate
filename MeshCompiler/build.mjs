// Bundles the tool into one self-contained HTML file that opens straight
// from disk (file://) with no server and no network.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'ReSkate_Mesh_Compiler.html');

const result = await build({
    entryPoints: [join(here, 'src/main.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome100', 'firefox100', 'safari15'],
    legalComments: 'eof',
    write: false,
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = (await readFile(join(here, 'src/styles.css'), 'utf8')).replace(/<\/style/gi, '<\\/style');
const html = (await readFile(join(here, 'src/index.html'), 'utf8'))
    .replace('/*STYLE*/', () => css)
    .replace('/*SCRIPT*/', () => js);
await writeFile(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
