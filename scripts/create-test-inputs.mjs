import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Local fixture for the two source matrices and the pre-credential deployment
// check. It reproduces the three Service-built files the stage base consumes: the
// two Lambda bundles and their runtime policy. The bytes are the same ones the
// pre-#193 fixture used, so the recorded Lambda asset identities stay identical.
// There is no release manifest: the published per-asset digest is the identity,
// and the deploy job proves the travelled bytes against it.
export async function createTestInputs(directory) {
  await mkdir(directory, { recursive: true });
  const zip = await readFile(new URL('../test/fixtures/placeholder.zip', import.meta.url));
  const policyBytes = await readFile(new URL('../test/fixtures/runtime-policy.json', import.meta.url));
  for (const [file, bytes] of Object.entries({ 'pre-sign-up.zip': zip, 'post-confirmation.zip': zip,
    'runtime-policy.json': policyBytes })) await writeFile(path.join(directory, file), bytes);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await createTestInputs(path.resolve(process.argv[2] ?? '.service-artifacts/test'));
