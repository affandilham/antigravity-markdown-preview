const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const extFolderName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
const homeDir = os.homedir();
const targetExtensionsDir = path.join(homeDir, '.antigravity-ide', 'extensions');
const targetExtDir = path.join(targetExtensionsDir, extFolderName);

console.log(`📦 Packaging & Installing ${pkg.displayName} v${pkg.version}...`);

// 1. Build extension
console.log('⚡ Running build...');
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

// 2. Ensure target directory exists
if (!fs.existsSync(targetExtensionsDir)) {
  fs.mkdirSync(targetExtensionsDir, { recursive: true });
}

// Clean old version if exists
if (fs.existsSync(targetExtDir)) {
  console.log(`🗑️  Removing existing version at ${targetExtDir}`);
  fs.rmSync(targetExtDir, { recursive: true, force: true });
}
fs.mkdirSync(targetExtDir, { recursive: true });

// 3. Copy essential files and folders
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

const itemsToCopy = ['package.json', 'README.md', 'dist', 'media'];

for (const item of itemsToCopy) {
  const srcPath = path.join(rootDir, item);
  const destPath = path.join(targetExtDir, item);
  if (fs.existsSync(srcPath)) {
    console.log(`📋 Copying ${item} -> ${destPath}`);
    copyRecursive(srcPath, destPath);
  }
}

console.log(`\n🎉 SUCCESS! Extension installed to:`);
console.log(`   ${targetExtDir}\n`);
console.log(`💡 To activate in Antigravity IDE:`);
console.log(`   1. Reload Antigravity IDE (Press Cmd+Shift+P -> "Developer: Reload Window")`);
console.log(`   2. Open any .md file and press Cmd+Shift+V or click the Preview icon in the editor toolbar!\n`);
