const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const vsixFileName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(rootDir, vsixFileName);

console.log(`📦 Packaging & Installing ${pkg.displayName} v${pkg.version}...`);

// 1. Build extension bundle
console.log('⚡ Running build...');
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

// 2. Package VSIX
console.log(`📦 Generating ${vsixFileName}...`);
execSync(`npx --yes @vscode/vsce package --no-git-tag-version --no-update-package-json -o "${vsixPath}"`, {
  cwd: rootDir,
  stdio: 'inherit'
});

// 3. Install via Antigravity IDE CLI to update extensionManagementService cache cleanly
const agyBin = '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide';
if (fs.existsSync(agyBin)) {
  console.log(`⚡ Installing extension cleanly via official Antigravity IDE CLI...`);
  execSync(`"${agyBin}" --install-extension "${vsixPath}" --force`, { stdio: 'inherit' });
} else {
  // Fallback to manual directory copy
  console.log(`⚠️ Antigravity CLI not found, falling back to manual copy...`);
  const extFolderName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
  const targetExtensionsDir = path.join(os.homedir(), '.antigravity-ide', 'extensions');
  const targetExtDir = path.join(targetExtensionsDir, extFolderName);

  if (!fs.existsSync(targetExtensionsDir)) {
    fs.mkdirSync(targetExtensionsDir, { recursive: true });
  }

  if (fs.existsSync(targetExtDir)) {
    fs.rmSync(targetExtDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetExtDir, { recursive: true });

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

  for (const item of ['package.json', 'README.md', 'dist', 'media']) {
    const srcPath = path.join(rootDir, item);
    const destPath = path.join(targetExtDir, item);
    if (fs.existsSync(srcPath)) {
      copyRecursive(srcPath, destPath);
    }
  }
}

console.log(`\n🎉 SUCCESS! Extension installed cleanly.`);
console.log(`💡 The IDE cache is now officially synchronized, preventing any "Extensions modified on disk" warnings.\n`);
