import path from 'node:path';

// Issue #344: the Client publication's identity and live interface. Under the
// single-writer architecture (ADR 0033 §9, §11) AnyWear-Client builds and verifies
// the bundle and hands its run id, run attempt and bundle digest to Infra's
// `mutate.yml` (`operation=publish-client`); Infra proves that run, downloads the
// `client-dist` artifact, re-hashes the bundle manifest, resolves the live Beta
// interface and performs the one publish. This module is the single definition of
// the identities, paths and interface keys the entry, the restricted session and
// the AWS call allow-list share, so the three cannot disagree about what is read,
// hashed or written.
//
// The two directories are the run's own scratch space: the verified tree that
// travels from `verify` to `deploy` as `client-publish-bytes-<run>-<attempt>`, and
// the one publication record the deploy job uploads. Both are inside the
// repository checkout and neither is committed.
const root = path.resolve(import.meta.dirname, '../..');

// The publisher repository, keyed on its immutable numeric id where the REST run
// object reports one: the owner name moves with the organization transfer while
// the id does not.
export const CLIENT_REPOSITORY = 'anywear-ai/AnyWear-Client';
export const CLIENT_REPOSITORY_ID = 1176104200;
// The one Client workflow that is the publisher. Infra proves the run it names is
// this file on `main`, so a dispatch naming a check run is refused.
export const CLIENT_WORKFLOW_PATH = '.github/workflows/release.yml';
export const CLIENT_REF = 'main';
// The artifact the Client build job publishes and the only bytes Infra syncs.
export const CLIENT_ARTIFACT_NAME = 'client-dist';
// The two files the publication needs from inside that artifact. `bundle-manifest`
// is the digested file; `build-metadata` carries the Client source commit and the
// interface values the bundle was compiled for, which the live interface must
// match before the first S3 write.
export const CLIENT_BUNDLE_MANIFEST = 'bundle-manifest.json';
export const CLIENT_BUILD_METADATA = 'build-metadata.json';
// The publication role is a reviewed literal in `mutate.yml`, the way the account
// and region are pinned: no operator has to create a repository variable for it,
// and both this module and the workflow name the same ARN.
export const CLIENT_PUBLICATION_ROLE_ARN = 'arn:aws:iam::650880818323:role/beta-client-publish-role';
// The live interface: three outputs/parameters of the persistent Beta Platform
// stack (`AnyWearPlatformStack-beta`) and the Beta SSM stage base.
export const CLIENT_PLATFORM_STACK = 'AnyWearPlatformStack-beta';
export const CLIENT_INTERFACE_OUTPUTS = Object.freeze({
  api_base_url: 'ApiBaseUrl',
  bucket: 'ClientBucketName',
  distribution_id: 'ClientDistributionId',
});
export const CLIENT_INTERFACE_PARAMETERS = Object.freeze({
  cognito_user_pool_id: '/anywear/beta/cognito_user_pool_id',
  cognito_client_id: '/anywear/beta/cognito_client_id',
});
/** The three values the built bundle records and the live interface must match. */
export const CLIENT_INTERFACE_KEYS = Object.freeze(['api_base_url', 'cognito_user_pool_id', 'cognito_client_id']);
/** The one file the publication record artifact carries. */
export const CLIENT_PUBLICATION_RECORD_NAME = 'client-publication-record.json';
// The verified tree `verify` publishes and `deploy` syncs. `s3 sync` writes the
// contents of this directory to the bucket root, exactly as the Client's retired
// publish job did, so `index.html` stays the distribution default root object.
export const CLIENT_DIST_DIRECTORY = path.join(root, '.client-artifacts', 'dist');
// The artifact is extracted here and normalised into `CLIENT_DIST_DIRECTORY`,
// because the artifact root depends on the Client's upload search path: the
// manifest is at `dist/bundle-manifest.json` inside the Client workspace and at
// `bundle-manifest.json` or `dist/bundle-manifest.json` inside the artifact.
export const CLIENT_DOWNLOAD_DIRECTORY = path.join(root, '.client-artifacts', 'download');
export const CLIENT_PUBLICATION_RECORD_PATH = path.join(root, '.client-publication', CLIENT_PUBLICATION_RECORD_NAME);
/** The distribution id form CloudFront returns; an output in any other shape is a refusal. */
export const CLOUDFRONT_DISTRIBUTION_ID = /^[A-Z0-9]+$/;
/** A CloudFront invalidation id. */
export const CLOUDFRONT_INVALIDATION_ID = /^[A-Za-z0-9]+$/;
/** An S3 bucket name in the only form this repository deploys. */
export const CLIENT_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// The publication's two writes, built once here so the caller that performs them
// and the session allow-list that admits them compare the same argument vectors.
// `s3 sync` writes the contents of the verified tree to the bucket root and
// removes every key the tree no longer carries; the invalidation covers the whole
// distribution, because a synced `index.html` changes every path's fallback.
export function clientSyncArguments(bucket) {
  return ['s3', 'sync', CLIENT_DIST_DIRECTORY, `s3://${bucket}`, '--delete'];
}
export function clientInvalidationArguments(distributionId) {
  return ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*'];
}
