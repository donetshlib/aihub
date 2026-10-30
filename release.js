// npm run release: builds the installer and publishes it as a GitHub release (needs GH_TOKEN).
// `node release.js --linux` does the same for Linux; GitHub Actions runs both on a pushed tag.
// electron-builder 26.15 creates the release from two parallel uploads at once and one of them
// fails with "Published releases must have a valid tag", so the release is created here first
// and the build only uploads into it.
const { execSync } = require('node:child_process');
const { version, build } = require('./package.json');

const { owner, repo } = build.publish[0];
const platform = process.argv[2] ?? '--win';
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('Set GH_TOKEN first: $env:GH_TOKEN="ghp_..."');
  process.exit(1);
}

(async () => {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ tag_name: `v${version}`, name: version, target_commitish: 'main' }),
  });
  const body = await response.json();
  // A release left behind by a failed run is reused: the build uploads the missing files into it.
  if (!response.ok && !body.errors?.some((e) => e.code === 'already_exists')) {
    console.error('GitHub:', response.status, JSON.stringify(body));
    process.exit(1);
  }
  // electron-builder only uploads into releases younger than 2 hours unless told otherwise.
  execSync(`npx electron-builder ${platform} --publish always`, { stdio: 'inherit', env: { ...process.env, EP_GH_IGNORE_TIME: 'true' } });
})();
