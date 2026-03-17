const fs = require('fs');
const { execSync } = require('child_process');

const type = process.argv[2] || 'patch';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ioPkg = JSON.parse(fs.readFileSync('io-package.json', 'utf8'));

// Version erhöhen
const [major, minor, patch] = pkg.version.split('.').map(Number);
const newVersion = type === 'major' ? `${major + 1}.0.0`
    : type === 'minor' ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;

console.log(`Bumping version: ${pkg.version} -> ${newVersion}`);

// Dateien aktualisieren
pkg.version = newVersion;
ioPkg.common.version = newVersion;

fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');
fs.writeFileSync('io-package.json', JSON.stringify(ioPkg, null, '\t') + '\n');

// Git Commit und Tag
execSync(`git add package.json io-package.json`);
execSync(`git commit -m "chore: bump version to ${newVersion}"`);
execSync(`git tag v${newVersion}`);

console.log(`\nTo push: git push && git push origin v${newVersion}`);
