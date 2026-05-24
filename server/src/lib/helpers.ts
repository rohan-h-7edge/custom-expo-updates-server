import crypto, { BinaryLike, BinaryToTextEncoding } from 'crypto';
import mime from 'mime';
import { getObjectAsBuffer, getObjectAsString, listDirectories, objectExists } from './s3';

/**
 * Thrown by update-serving functions when the client already has the latest update.
 * The manifest handler catches this and returns a "noUpdateAvailable" directive instead
 * of a full manifest, saving the client from downloading something it doesn't need.
 */
export class NoUpdateAvailableError extends Error {}

/**
 * Base URL of the CloudFront distribution (e.g. https://xxxx.cloudfront.net).
 * Used to build asset URLs that are served directly from S3 via CloudFront —
 * assets never go through Lambda, they hit CloudFront → S3 directly.
 */
const ASSETS_BASE_URL = process.env.ASSETS_BASE_URL!;

/**
 * Generic hashing utility.
 * Used in two ways:
 *  - SHA-256 + base64 → asset integrity hash (verified by expo-updates on the device)
 *  - MD5 + hex        → asset key (used as the filename in the asset URL)
 */
function createHash(file: BinaryLike, hashingAlgorithm: string, encoding: BinaryToTextEncoding) {
  return crypto.createHash(hashingAlgorithm).update(file).digest(encoding);
}

/**
 * Converts a standard base64 string to base64url encoding.
 * expo-updates expects base64url (URL-safe) for asset hashes in the manifest —
 * base64url replaces + with -, / with _, and strips trailing = padding.
 */
function getBase64URLEncoding(base64EncodedString: string): string {
  return base64EncodedString.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Converts a 64-character SHA-256 hex string into a UUID v4-like format.
 * expo-updates uses UUIDs to identify updates (manifest id field).
 * We derive the UUID deterministically from the metadata.json content hash
 * so the same update always gets the same ID — this is how the client detects
 * "I already have this update" via the expo-current-update-id header.
 *
 * Example: "aabbccdd1122..." → "aabbccdd-1122-3344-5566-778899aabbcc"
 */
export function convertSHA256HashToUUID(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/**
 * TypeScript type guard that filters out null/undefined values from arrays.
 * Used with Array.filter() to get a typed non-nullable array back.
 */
export function truthy<TValue>(value: TValue | null | undefined): value is TValue {
  return !!value;
}

/**
 * Finds the S3 key prefix for the most recent update bundle for a given runtime version.
 *
 * S3 structure: updates/{runtimeVersion}/{timestamp}/
 * Each publish creates a new timestamp directory (Unix epoch in seconds).
 * We list all timestamp directories, sort them numerically descending,
 * and return the path to the highest (most recent) one.
 *
 * Example: runtimeVersion="2" might find directories ["1716000000", "1716500000"]
 * and return "updates/2/1716500000"
 *
 * Throws if no directories exist for the given runtime version —
 * the manifest handler converts this into a 404 response.
 */
export async function getLatestUpdateBundlePathForRuntimeVersionAsync(
  runtimeVersion: string,
): Promise<string> {
  const prefix = `updates/${runtimeVersion}/`;
  const directories = await listDirectories(prefix);

  if (directories.length === 0) {
    throw new Error('Unsupported runtime version');
  }

  const sorted = directories.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  return `${prefix}${sorted[0]}`;
}

/**
 * Discriminated union type for getAssetMetadataAsync.
 * The launch asset (the main JS bundle) is treated differently:
 *  - It has no file extension in the source, its content-type is always application/javascript
 *    and its URL suffix is always ".bundle"
 *  - Regular assets (images, fonts, etc.) have a real extension like ".png" or ".ttf"
 */
type GetAssetMetadataArg =
  | {
      updateBundlePath: string;
      filePath: string;
      ext: null;
      isLaunchAsset: true;
      runtimeVersion: string;
      platform: string;
    }
  | {
      updateBundlePath: string;
      filePath: string;
      ext: string;
      isLaunchAsset: false;
      runtimeVersion: string;
      platform: string;
    };

/**
 * Reads an asset from S3 and computes all the metadata expo-updates needs
 * to include it in the manifest.
 *
 * What each field means:
 *  - hash     : SHA-256 of the file content in base64url — the client verifies this
 *               after downloading the asset to detect corruption or tampering
 *  - key      : MD5 hex of the file content — used as the asset filename in the URL
 *               (content-addressed, so the same file always gets the same key)
 *  - fileExtension : e.g. ".png", ".ttf", ".bundle" — tells the client how to store it
 *  - contentType   : MIME type sent in the HTTP response when CloudFront serves the asset
 *  - url      : CloudFront URL where the client will download this asset from.
 *               This points directly to S3 via CloudFront — Lambda is NOT involved
 *               in serving assets, only in serving manifests.
 */
export async function getAssetMetadataAsync(arg: GetAssetMetadataArg) {
  const s3Key = `${arg.updateBundlePath}/${arg.filePath}`;
  const assetBuffer = await getObjectAsBuffer(s3Key);

  const assetHash = getBase64URLEncoding(createHash(assetBuffer, 'sha256', 'base64'));
  const key = createHash(assetBuffer, 'md5', 'hex');
  const keyExtensionSuffix = arg.isLaunchAsset ? 'bundle' : arg.ext;
  const contentType = arg.isLaunchAsset ? 'application/javascript' : mime.getType(arg.ext!);

  return {
    hash: assetHash,
    key,
    fileExtension: `.${keyExtensionSuffix}`,
    contentType,
    url: `${ASSETS_BASE_URL}/api/assets/${key}.${keyExtensionSuffix}`,
  };
}

/**
 * Reads and parses the metadata.json file for an update bundle from S3.
 *
 * metadata.json is generated by `expo export` and contains:
 *  - fileMetadata.android / fileMetadata.ios : paths to the JS bundle and assets
 *    for each platform, along with their file extensions
 *
 * We also derive a stable update ID from the SHA-256 hash of metadata.json's
 * raw content. This means:
 *  - Same update published twice → same ID (idempotent)
 *  - Any change to metadata → different ID → client downloads the update
 *
 * NOTE: createdAt currently uses the current request time. In production,
 * store a createdAt timestamp inside metadata.json at publish time instead.
 */
export async function getMetadataAsync({
  updateBundlePath,
  runtimeVersion,
}: {
  updateBundlePath: string;
  runtimeVersion: string;
}) {
  const metadataKey = `${updateBundlePath}/metadata.json`;
  const updateMetadataString = await getObjectAsString(metadataKey);
  const updateMetadataBuffer = Buffer.from(updateMetadataString, 'utf-8');
  const metadataJson = JSON.parse(updateMetadataString);

  // Derive a deterministic update ID from the file content.
  // The manifest handler converts this to a UUID and sends it as the manifest "id".
  // The client stores this ID and sends it back on the next check via
  // expo-current-update-id header — if it matches, we return noUpdateAvailable.
  const id = createHash(updateMetadataBuffer, 'sha256', 'hex');

  const createdAt = new Date().toISOString();

  return { metadataJson, createdAt, id };
}

/**
 * Reads and parses the expoConfig.json for an update bundle from S3.
 *
 * expoConfig.json is generated at publish time by running `@expo/config`
 * against the client project. It contains the full resolved app.json config.
 *
 * It is included in the manifest under extra.expoClient — many Expo SDK
 * modules (e.g. expo-constants) read their configuration from this field
 * at runtime, so OTA updates can deliver config changes alongside code changes.
 */
export async function getExpoConfigAsync({
  updateBundlePath,
}: {
  updateBundlePath: string;
  runtimeVersion?: string;
}): Promise<any> {
  const key = `${updateBundlePath}/expoConfig.json`;
  const content = await getObjectAsString(key);
  return JSON.parse(content);
}

/**
 * Builds a rollBackToEmbedded directive for the expo-updates protocol.
 *
 * A rollback is triggered by uploading a zero-byte file named "rollback"
 * inside a timestamp directory in S3 (instead of a normal update bundle).
 * When the manifest handler detects this file, it tells the client to
 * discard all downloaded updates and revert to the JS bundle that was
 * embedded in the native app binary at build time.
 *
 * This is useful when a bad update has been shipped and you need to
 * immediately revert all devices to a known-good state without a new build.
 *
 * Throws if no rollback sentinel file is found — means the directory is
 * a normal update, not a rollback.
 */
export async function createRollBackDirectiveAsync(updateBundlePath: string) {
  const rollbackKey = `${updateBundlePath}/rollback`;
  const exists = await objectExists(rollbackKey);
  if (!exists) {
    throw new Error(`No rollback found at ${rollbackKey}`);
  }
  return {
    type: 'rollBackToEmbedded',
    parameters: {
      commitTime: new Date().toISOString(),
    },
  };
}

/**
 * Builds a noUpdateAvailable directive.
 * Sent to the client when it already has the latest update (its
 * expo-current-update-id header matches our latest update's ID).
 * Tells the client "you're up to date, nothing to download."
 * Only supported in expo-updates protocol version 1+.
 */
export async function createNoUpdateAvailableDirectiveAsync() {
  return { type: 'noUpdateAvailable' };
}

/**
 * Checks whether the latest update directory for a given path is a rollback.
 * A rollback directory contains a zero-byte "rollback" sentinel file instead
 * of the normal metadata.json + bundle files.
 * Called by the manifest handler to decide which response type to build.
 */
export async function isRollbackUpdateAsync(updateBundlePath: string): Promise<boolean> {
  return objectExists(`${updateBundlePath}/rollback`);
}
