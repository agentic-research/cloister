import fs from 'fs';
import path from 'path';

const distDir = path.join(process.cwd(), 'dist');
const files = fs.readdirSync(distDir);
const wasmFiles = files.filter(f => f.endsWith('.wasm') && f.includes('-'));

let indexJs = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');

for (const wasm of wasmFiles) {
  const parts = wasm.split('-');
  const newName = parts.slice(1).join('-');
  fs.renameSync(path.join(distDir, wasm), path.join(distDir, newName));
  indexJs = indexJs.split(`./${wasm}`).join(newName); // Use exact string without ./ for workerd? Or with?
  console.log(`Renamed ${wasm} to ${newName}`);
}

fs.writeFileSync(path.join(distDir, 'index.js'), indexJs);
