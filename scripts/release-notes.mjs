import { readFile, writeFile } from 'node:fs/promises';

const [tag, output] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!tag || !output || tag !== `v${packageJson.version}`) throw new Error('Release tag must match package.json version.');
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const heading = `## ${packageJson.version} — `;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`Changelog entry for ${tag} is missing.`);
const body = changelog.slice(start + heading.length).split(/\n## /, 1)[0];
const firstNewline = body.indexOf('\n');
const notes = body.slice(firstNewline + 1).trim();
if (!notes) throw new Error(`Changelog entry for ${tag} is empty.`);
await writeFile(output, `${notes}\n`);
