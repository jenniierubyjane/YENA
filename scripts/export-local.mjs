import fs from 'node:fs/promises';
const html=await fs.readFile('dist/index.html','utf8');
const css=await fs.readFile('dist/styles.css','utf8');
const core=(await fs.readFile('dist/core.mjs','utf8')).replace(/^export /gm,'');
const portal=(await fs.readFile('dist/portal.mjs','utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const app=(await fs.readFile('dist/app.mjs','utf8')).replace(/^import .*;\r?\n/gm,'');
const bundled=html.replace('<link rel="stylesheet" href="styles.css">',()=>`<style>\n${css}\n</style>`).replace('<script type="module" src="app.mjs"></script>',()=>`<script type="module">\n${core}\nconst esc=escapeHtml;\n${portal}\n${app}\n</script>`);
await fs.writeFile('YENA-demonstracao.html',bundled);
console.log('HTML independente gerado: YENA-demonstracao.html');
