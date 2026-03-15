import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  classifyFile,
  isBinaryExtension,
  isPotentialSecretFile,
  limitBytes,
  nowIso,
  projectSlug,
} from '../dist/utils.js';

// projectSlug
test('projectSlug: converts path separators to dashes', () => {
  const slug = projectSlug('/home/user/my-project');
  assert.ok(slug.includes('-home-user-my-project'));
});

test('projectSlug: resolves relative paths before converting', () => {
  const slug = projectSlug('relative/path');
  // resolved path will be an absolute path with separators
  assert.ok(typeof slug === 'string');
  assert.ok(slug.length > 0);
});

test('projectSlug: returns a string starting with a dash', () => {
  const slug = projectSlug('/foo/bar');
  // resolved absolute path starts with /, so becomes -foo-bar, then prepended with -
  assert.ok(slug.startsWith('-'));
});

// classifyFile
test('classifyFile: classifies src/api/ as API', () => {
  assert.equal(classifyFile('src/api/users.ts'), 'API');
});

test('classifyFile: classifies components/ as Component', () => {
  assert.equal(classifyFile('components/Button.tsx'), 'Component');
});

test('classifyFile: classifies lib/ as Library', () => {
  assert.equal(classifyFile('lib/helpers.ts'), 'Library');
});

test('classifyFile: classifies hooks/ as Hook', () => {
  assert.equal(classifyFile('hooks/useAuth.ts'), 'Hook');
});

test('classifyFile: classifies stores/ as State', () => {
  assert.equal(classifyFile('stores/authStore.ts'), 'State');
});

test('classifyFile: classifies utils/ as Utility', () => {
  assert.equal(classifyFile('utils/format.ts'), 'Utility');
});

test('classifyFile: classifies test/ as Test', () => {
  assert.equal(classifyFile('test/foo.test.ts'), 'Test');
});

test('classifyFile: classifies __tests__/ as Test', () => {
  assert.equal(classifyFile('__tests__/unit.test.ts'), 'Test');
});

test('classifyFile: classifies .github/ as CI/CD', () => {
  assert.equal(classifyFile('.github/workflows/ci.yml'), 'CI/CD');
});

test('classifyFile: classifies scripts/ as Script', () => {
  assert.equal(classifyFile('scripts/deploy.sh'), 'Script');
});

test('classifyFile: classifies docs/ as Documentation', () => {
  assert.equal(classifyFile('docs/README.md'), 'Documentation');
});

test('classifyFile: returns Other for unknown path', () => {
  assert.equal(classifyFile('something/unknown.ts'), 'Other');
});

test('classifyFile: accepts custom rules', () => {
  const result = classifyFile('custom/path.ts', [{ pattern: 'custom/', category: 'Custom' }]);
  assert.equal(result, 'Custom');
});

// isPotentialSecretFile
test('isPotentialSecretFile: detects .env files', () => {
  assert.equal(isPotentialSecretFile('.env'), true);
  assert.equal(isPotentialSecretFile('.env.local'), true);
  assert.equal(isPotentialSecretFile('config/.env.production'), true);
});

test('isPotentialSecretFile: detects files with "secret" in name', () => {
  assert.equal(isPotentialSecretFile('config/secret.json'), true);
  assert.equal(isPotentialSecretFile('my-secrets.ts'), true);
});

test('isPotentialSecretFile: detects files with "credential" in name', () => {
  assert.equal(isPotentialSecretFile('credentials.json'), true);
  assert.equal(isPotentialSecretFile('gcloud-credential.json'), true);
});

test('isPotentialSecretFile: detects files with "token" in name', () => {
  assert.equal(isPotentialSecretFile('token.json'), true);
  assert.equal(isPotentialSecretFile('access-token.txt'), true);
});

test('isPotentialSecretFile: detects PEM and certificate files', () => {
  assert.equal(isPotentialSecretFile('server.pem'), true);
  assert.equal(isPotentialSecretFile('cert.p12'), true);
  assert.equal(isPotentialSecretFile('keystore.jks'), true);
});

test('isPotentialSecretFile: detects SSH key files', () => {
  assert.equal(isPotentialSecretFile('id_rsa'), true);
  assert.equal(isPotentialSecretFile('id_ed25519'), true);
  assert.equal(isPotentialSecretFile('id_rsa.pub'), true);
});

test('isPotentialSecretFile: detects .htpasswd, .pgpass, .netrc', () => {
  assert.equal(isPotentialSecretFile('.htpasswd'), true);
  assert.equal(isPotentialSecretFile('.pgpass'), true);
  assert.equal(isPotentialSecretFile('.netrc'), true);
});

test('isPotentialSecretFile: does not flag .keymap files', () => {
  assert.equal(isPotentialSecretFile('settings.keymap'), false);
});

test('isPotentialSecretFile: does not flag .ts files with "key" in path', () => {
  // ends with .ts so "key" check is skipped
  assert.equal(isPotentialSecretFile('src/keyboard-shortcuts.ts'), false);
});

test('isPotentialSecretFile: does not flag regular source files', () => {
  assert.equal(isPotentialSecretFile('src/components/Button.tsx'), false);
  assert.equal(isPotentialSecretFile('lib/utils.ts'), false);
  assert.equal(isPotentialSecretFile('README.md'), false);
});

// isBinaryExtension
test('isBinaryExtension: detects image files', () => {
  assert.equal(isBinaryExtension('image.png'), true);
  assert.equal(isBinaryExtension('photo.jpg'), true);
  assert.equal(isBinaryExtension('photo.jpeg'), true);
  assert.equal(isBinaryExtension('anim.gif'), true);
  assert.equal(isBinaryExtension('img.webp'), true);
  assert.equal(isBinaryExtension('favicon.ico'), true);
});

test('isBinaryExtension: detects PDF', () => {
  assert.equal(isBinaryExtension('document.pdf'), true);
});

test('isBinaryExtension: detects archives', () => {
  assert.equal(isBinaryExtension('archive.zip'), true);
});

test('isBinaryExtension: detects video files', () => {
  assert.equal(isBinaryExtension('video.mp4'), true);
  assert.equal(isBinaryExtension('clip.mov'), true);
  assert.equal(isBinaryExtension('clip.webm'), true);
});

test('isBinaryExtension: detects font files', () => {
  assert.equal(isBinaryExtension('font.woff'), true);
  assert.equal(isBinaryExtension('font.woff2'), true);
  assert.equal(isBinaryExtension('font.ttf'), true);
  assert.equal(isBinaryExtension('font.otf'), true);
});

test('isBinaryExtension: detects wasm and executables', () => {
  assert.equal(isBinaryExtension('module.wasm'), true);
  assert.equal(isBinaryExtension('app.exe'), true);
  assert.equal(isBinaryExtension('lib.dylib'), true);
  assert.equal(isBinaryExtension('lib.so'), true);
  assert.equal(isBinaryExtension('data.bin'), true);
});

test('isBinaryExtension: case insensitive', () => {
  assert.equal(isBinaryExtension('IMAGE.PNG'), true);
  assert.equal(isBinaryExtension('VIDEO.MP4'), true);
});

test('isBinaryExtension: returns false for text files', () => {
  assert.equal(isBinaryExtension('file.ts'), false);
  assert.equal(isBinaryExtension('file.js'), false);
  assert.equal(isBinaryExtension('file.json'), false);
  assert.equal(isBinaryExtension('file.md'), false);
  assert.equal(isBinaryExtension('file.txt'), false);
});

// limitBytes
test('limitBytes: returns text unchanged when under limit', () => {
  const text = 'hello world';
  assert.equal(limitBytes(text, 1000), text);
});

test('limitBytes: truncates text exceeding maxBytes', () => {
  const text = 'a'.repeat(100);
  const result = limitBytes(text, 10);
  assert.ok(result.length < text.length);
  assert.ok(result.includes('[truncated by mmbridge]'));
});

test('limitBytes: truncation appends marker', () => {
  const text = 'x'.repeat(200);
  const result = limitBytes(text, 50);
  assert.ok(result.endsWith('[truncated by mmbridge]'));
});

test('limitBytes: exact byte limit is not truncated', () => {
  const text = 'hello'; // 5 bytes UTF-8
  const result = limitBytes(text, 5);
  assert.equal(result, text);
});

// nowIso
test('nowIso: returns a valid ISO string', () => {
  const iso = nowIso();
  assert.equal(typeof iso, 'string');
  // Should parse without throwing
  const date = new Date(iso);
  assert.ok(!Number.isNaN(date.getTime()));
});

test('nowIso: returns current time approximately', () => {
  const before = Date.now();
  const iso = nowIso();
  const after = Date.now();
  const ts = new Date(iso).getTime();
  assert.ok(ts >= before);
  assert.ok(ts <= after);
});
