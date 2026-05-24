import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import crypto from 'crypto';
import { Dictionary } from 'structured-headers';

/**
 * Single shared Secrets Manager client for the Lambda function.
 * Like the S3 client, this is initialised once per Lambda execution context
 * and reused across warm invocations.
 */
const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });

/**
 * In-memory cache for the RSA private key PEM string.
 *
 * Why cache it?
 * Secrets Manager charges per API call (~$0.05 per 10,000 calls).
 * More importantly, fetching from Secrets Manager adds ~50-100ms latency.
 * Lambda execution contexts are reused across multiple invocations (warm starts),
 * so caching at the module level means we only fetch the secret once per
 * Lambda container lifetime — all subsequent invocations use the cached value.
 *
 * This is safe because the private key rarely changes. If you rotate the key,
 * the old containers will eventually be recycled and new ones will fetch the
 * updated secret automatically.
 */
let cachedPrivateKey: string | null = null;

/**
 * Fetches the RSA private key PEM from AWS Secrets Manager.
 *
 * The secret ARN is passed via the PRIVATE_KEY_SECRET_ARN environment variable,
 * which is set by Serverless Framework at deploy time (hardcoded in serverless.yml).
 *
 * Returns null if:
 *  - PRIVATE_KEY_SECRET_ARN is not set (e.g. local dev without secrets configured)
 * The manifest handler treats null as "no signing configured" and returns an
 * error if the client requested a signature via expo-expect-signature header.
 *
 * Flow:
 *  1. Check module-level cache — return immediately if already fetched
 *  2. Call Secrets Manager to get the secret value
 *  3. Store in cache and return the PEM string
 */
export async function getPrivateKeyAsync(): Promise<string | null> {
  const secretArn = process.env.PRIVATE_KEY_SECRET_ARN;
  if (!secretArn) return null;

  if (cachedPrivateKey) return cachedPrivateKey;

  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  cachedPrivateKey = response.SecretString ?? null;
  return cachedPrivateKey;
}

/**
 * Signs a string payload using RSA-SHA256 and returns the signature in base64.
 *
 * This is the algorithm required by the expo-updates code signing specification:
 *   alg: "rsa-v1_5-sha256"
 *
 * How it works:
 *  1. Create a SHA-256 digest of the payload string (UTF-8 encoded)
 *  2. Encrypt the digest with the RSA private key (PKCS#1 v1.5 padding)
 *  3. Return the result as a base64 string
 *
 * The client verifies this signature using the public certificate stored
 * in expo-updates-client/code-signing/certificate.pem — if the signature
 * doesn't match, the client rejects the update entirely, preventing
 * any tampered or malicious update from being applied.
 */
export function signRSASHA256(data: string, privateKey: string): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data, 'utf8');
  sign.end();
  return sign.sign(privateKey, 'base64');
}

/**
 * Converts a plain key-value object into the structured-headers Dictionary format.
 *
 * The expo-updates protocol sends the signature in the expo-signature HTTP header
 * using the Structured Field Values (RFC 8941) dictionary format, e.g.:
 *   expo-signature: sig="abc123...", keyid="main"
 *
 * The structured-headers library serializes this format. It expects a Map where:
 *  - Each key maps to a tuple of [value, parameters]
 *  - Parameters is an inner Map (empty here — no per-field params needed)
 *
 * Example input:  { sig: "abc123", keyid: "main" }
 * Example output: Map { "sig" => ["abc123", Map{}], "keyid" => ["main", Map{}] }
 *
 * After serializeDictionary() this becomes: sig="abc123", keyid="main"
 */
export function convertToDictionaryItemsRepresentation(obj: {
  [key: string]: string;
}): Dictionary {
  return new Map(
    Object.entries(obj).map(([k, v]) => [k, [v, new Map()]]),
  );
}
