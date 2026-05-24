import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import FormData from 'form-data';
import { serializeDictionary } from 'structured-headers';

import {
  NoUpdateAvailableError,
  convertSHA256HashToUUID,
  createNoUpdateAvailableDirectiveAsync,
  createRollBackDirectiveAsync,
  getAssetMetadataAsync,
  getExpoConfigAsync,
  getLatestUpdateBundlePathForRuntimeVersionAsync,
  getMetadataAsync,
  isRollbackUpdateAsync,
} from '../lib/helpers';
import { RequestLog, writeRequestLog } from '../lib/logger';
import {
  convertToDictionaryItemsRepresentation,
  getPrivateKeyAsync,
  signRSASHA256,
} from '../lib/signing';

/**
 * Main Lambda handler — the only entry point for the expo-updates manifest protocol.
 *
 * Every time an Expo app launches or checks for updates, it sends a GET request
 * here with these headers:
 *   expo-platform            : "ios" or "android"
 *   expo-runtime-version     : the runtimeVersion from app.json (e.g. "2")
 *   expo-protocol-version    : "0" or "1" (1 supports directives like noUpdateAvailable)
 *   expo-current-update-id   : UUID of the update the app currently has loaded
 *   expo-embedded-update-id  : UUID of the update embedded in the binary at build time
 *   expo-expect-signature    : present if the app wants a signed manifest (code signing)
 *
 * Decision flow:
 *   1. Validate headers
 *   2. Find the latest update bundle in S3 for the given runtimeVersion
 *   3. If the bundle directory has a "rollback" sentinel file → return rollback directive
 *   4. Otherwise → build and return a full update manifest
 *   5. If the client already has the latest update → return noUpdateAvailable directive
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method !== 'GET') {
    return jsonResponse(405, { error: 'Expected GET.' });
  }

  const headers = event.headers ?? {};

  const protocolVersionRaw = headers['expo-protocol-version'] ?? '0';
  const protocolVersion = parseInt(protocolVersionRaw, 10);

  const platform = headers['expo-platform'];
  const runtimeVersion = headers['expo-runtime-version'];

  const log: RequestLog = {
    requestId: event.requestContext.requestId,
    timestamp: new Date().toISOString(),
    platform,
    runtimeVersion,
    currentUpdateId: headers['expo-current-update-id'],
    embeddedUpdateId: headers['expo-embedded-update-id'],
    protocolVersion,
    outcome: 'bad_request',
    statusCode: 400,
  };

  const respond = async (result: APIGatewayProxyResultV2): Promise<APIGatewayProxyResultV2> => {
    log.statusCode = (result as any).statusCode;
    await writeRequestLog(log);
    return result;
  };

  if (platform !== 'ios' && platform !== 'android') {
    return respond(jsonResponse(400, { error: 'Unsupported platform. Expected either ios or android.' }));
  }

  if (!runtimeVersion) {
    return respond(jsonResponse(400, { error: 'No runtimeVersion provided.' }));
  }

  let updateBundlePath: string;
  try {
    updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
  } catch (error: any) {
    log.outcome = 'not_found';
    log.error = error.message;
    return respond(jsonResponse(404, { error: error.message }));
  }

  log.updateBundlePath = updateBundlePath;

  const isRollback = await isRollbackUpdateAsync(updateBundlePath);

  try {
    let result: APIGatewayProxyResultV2;
    if (isRollback) {
      log.outcome = 'rollback';
      result = await buildRollbackResponse(headers, updateBundlePath, protocolVersion);
    } else {
      log.outcome = 'update_served';
      result = await buildUpdateResponse(headers, updateBundlePath, runtimeVersion, platform, protocolVersion, log);
    }
    return respond(result);
  } catch (error) {
    if (error instanceof NoUpdateAvailableError) {
      log.outcome = 'no_update';
      return respond(await buildNoUpdateAvailableResponse(headers, protocolVersion));
    }
    console.error(error);
    log.outcome = 'error';
    log.error = error instanceof Error ? error.message : String(error);
    return respond(jsonResponse(500, { error: 'Internal server error.' }));
  }
};

/**
 * Builds a full update manifest response.
 *
 * This is the normal case — a new update exists that the client doesn't have yet.
 *
 * Steps:
 *  1. Read metadata.json from S3 — contains file paths for the bundle and assets
 *  2. Derive the update ID from the SHA-256 hash of metadata.json content
 *  3. Compare with expo-current-update-id header — if they match, client is up to date
 *  4. Read expoConfig.json — included in the manifest so Expo SDK modules get config
 *  5. Compute hash + URL for every asset and the launch (JS) bundle
 *  6. Sign the manifest JSON with the RSA private key (if client requested signing)
 *  7. Return a multipart/mixed response with two parts:
 *     - "manifest" part: the JSON manifest (with optional expo-signature header)
 *     - "extensions" part: per-asset request headers (empty for our setup)
 */
async function buildUpdateResponse(
  headers: Record<string, string | undefined>,
  updateBundlePath: string,
  runtimeVersion: string,
  platform: string,
  protocolVersion: number,
  log: RequestLog,
): Promise<APIGatewayProxyResultV2> {
  const currentUpdateId = headers['expo-current-update-id'];
  const { metadataJson, createdAt, id } = await getMetadataAsync({ updateBundlePath, runtimeVersion });
  log.manifestId = convertSHA256HashToUUID(id);

  // If the client's current update ID matches our latest, no update is needed.
  // Only throw NoUpdateAvailableError on protocol v1 — v0 doesn't support the directive
  // so we fall through and serve the manifest again (client will ignore it).
  if (currentUpdateId === convertSHA256HashToUUID(id) && protocolVersion === 1) {
    throw new NoUpdateAvailableError();
  }

  const expoConfig = await getExpoConfigAsync({ updateBundlePath, runtimeVersion });

  // fileMetadata contains platform-specific paths from expo export output.
  // Structure: { android: { bundle: "...", assets: [{path, ext}, ...] }, ios: {...} }
  const platformSpecificMetadata = metadataJson.fileMetadata[platform];

  const manifest = {
    id: convertSHA256HashToUUID(id),
    createdAt,
    runtimeVersion,
    // Fetch each asset from S3, compute its hash and build its CloudFront URL.
    // All asset fetches run in parallel via Promise.all for performance.
    assets: await Promise.all(
      (platformSpecificMetadata.assets as any[]).map((asset: any) =>
        getAssetMetadataAsync({
          updateBundlePath,
          filePath: asset.path,
          ext: asset.ext,
          runtimeVersion,
          platform,
          isLaunchAsset: false,
        }),
      ),
    ),
    // The launch asset is the main JS bundle — treated separately because its
    // content-type is always application/javascript and extension is always .bundle
    launchAsset: await getAssetMetadataAsync({
      updateBundlePath,
      filePath: platformSpecificMetadata.bundle,
      isLaunchAsset: true,
      runtimeVersion,
      platform,
      ext: null,
    }),
    metadata: {},
    // extra.expoClient is read by Expo SDK modules (expo-constants etc.) at runtime
    extra: { expoClient: expoConfig },
  };

  // Sign the manifest JSON string — the signature is attached as the expo-signature
  // header on the manifest multipart part, not on the HTTP response itself.
  const signature = await buildSignature(headers, JSON.stringify(manifest));
  if (signature === false) {
    return jsonResponse(400, { error: 'Code signing requested but no key configured.' });
  }

  // Build multipart/mixed body — required by the expo-updates protocol.
  // Part 1 "manifest": the JSON manifest with optional signature header.
  // Part 2 "extensions": per-asset custom headers (unused here, but required by spec).
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });
  form.append('extensions', JSON.stringify({ assetRequestHeaders: {} }), {
    contentType: 'application/json',
  });

  return multipartResponse(form, protocolVersion);
}

/**
 * Builds a rollBackToEmbedded directive response.
 *
 * Triggered when the latest S3 update directory contains a zero-byte "rollback" file
 * instead of normal update bundle files. This tells the client to discard all
 * downloaded OTA updates and revert to the JS bundle that was embedded in the
 * native binary at build time.
 *
 * Use case: you shipped a bad update and need to instantly revert all devices.
 * Upload a zero-byte "rollback" file to a new timestamp directory in S3 and
 * all clients will roll back on their next update check.
 *
 * Only supported on protocol version 1+.
 * If the client is already on the embedded update (currentUpdateId === embeddedUpdateId),
 * there's nothing to roll back to — throw NoUpdateAvailableError.
 */
async function buildRollbackResponse(
  headers: Record<string, string | undefined>,
  updateBundlePath: string,
  protocolVersion: number,
): Promise<APIGatewayProxyResultV2> {
  if (protocolVersion === 0) {
    return jsonResponse(400, { error: 'Rollbacks not supported on protocol version 0.' });
  }

  // expo-embedded-update-id is the ID of the bundle baked into the native binary.
  // We need this to know whether the client is already on the embedded update.
  const embeddedUpdateId = headers['expo-embedded-update-id'];
  if (!embeddedUpdateId) {
    return jsonResponse(400, { error: 'Invalid Expo-Embedded-Update-ID request header specified.' });
  }

  // If current === embedded, the client is already on the embedded update — nothing to do.
  const currentUpdateId = headers['expo-current-update-id'];
  if (currentUpdateId === embeddedUpdateId) {
    throw new NoUpdateAvailableError();
  }

  const directive = await createRollBackDirectiveAsync(updateBundlePath);
  const signature = await buildSignature(headers, JSON.stringify(directive));
  if (signature === false) {
    return jsonResponse(400, { error: 'Code signing requested but no key configured.' });
  }

  // Directives use the same multipart/mixed format as manifests,
  // but the part is named "directive" instead of "manifest".
  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  return multipartResponse(form, protocolVersion);
}

/**
 * Builds a noUpdateAvailable directive response.
 *
 * Sent when the client already has the latest update loaded
 * (expo-current-update-id matches our latest update's ID).
 * This saves the client from having to parse a full manifest
 * just to discover there's nothing new.
 *
 * Only supported on protocol version 1+.
 */
async function buildNoUpdateAvailableResponse(
  headers: Record<string, string | undefined>,
  protocolVersion: number,
): Promise<APIGatewayProxyResultV2> {
  if (protocolVersion === 0) {
    return jsonResponse(400, { error: 'NoUpdateAvailable directive not available in protocol version 0.' });
  }

  const directive = await createNoUpdateAvailableDirectiveAsync();
  const signature = await buildSignature(headers, JSON.stringify(directive));
  if (signature === false) {
    return jsonResponse(400, { error: 'Code signing requested but no key configured.' });
  }

  const form = new FormData();
  form.append('directive', JSON.stringify(directive), {
    contentType: 'application/json',
    header: {
      'content-type': 'application/json; charset=utf-8',
      ...(signature ? { 'expo-signature': signature } : {}),
    },
  });

  return multipartResponse(form, protocolVersion);
}

/**
 * Signs a manifest or directive payload for code signing verification on the client.
 *
 * Returns:
 *  - string  : the serialized expo-signature header value (signing succeeded)
 *  - null    : client did not request signing (expo-expect-signature header absent)
 *  - false   : client requested signing but no private key is configured on the server
 *
 * The caller treats `false` as an error (400) and `null` as "skip signing".
 *
 * The signature format is a Structured Field Values dictionary:
 *   sig="<base64-rsa-sha256-signature>", keyid="main"
 * The client looks up the certificate matching keyid="main" from its
 * codeSigningCertificate path in app.json and verifies the signature.
 */
async function buildSignature(
  headers: Record<string, string | undefined>,
  payload: string,
): Promise<string | null | false> {
  if (!headers['expo-expect-signature']) return null;

  const privateKey = await getPrivateKeyAsync();
  if (!privateKey) return false;

  const hashSignature = signRSASHA256(payload, privateKey);
  const dictionary = convertToDictionaryItemsRepresentation({
    sig: hashSignature,
    keyid: 'main',
  });
  return serializeDictionary(dictionary);
}

/**
 * Builds the HTTP response for a multipart/mixed body.
 *
 * The expo-updates protocol requires multipart/mixed responses (not plain JSON)
 * so that each part (manifest, extensions, directive) can carry its own headers
 * like expo-signature independently.
 *
 * API Gateway requires binary bodies to be base64-encoded with isBase64Encoded: true.
 * FormData.getBuffer() returns a Buffer — we convert it to base64 for API Gateway.
 *
 * cache-control: private, max-age=0 ensures CloudFront never caches manifest responses —
 * every device always gets a fresh check directly from Lambda.
 */

function multipartResponse(form: FormData, protocolVersion: number): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: {
      'expo-protocol-version': String(protocolVersion),
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
      'content-type': `multipart/mixed; boundary=${form.getBoundary()}`,
    },
    body: form.getBuffer().toString('base64'),
    isBase64Encoded: true,
  };
}

/**
 * Builds a simple JSON error response.
 * Used for 400/404/405/500 responses where the client expects a JSON error body.
 */
function jsonResponse(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
