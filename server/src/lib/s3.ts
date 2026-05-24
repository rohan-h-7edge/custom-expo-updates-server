import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Single shared S3 client for the Lambda function.
 * AWS_NODEJS_CONNECTION_REUSE_ENABLED=1 (set in serverless.yml) makes this client
 * reuse the underlying HTTP/TCP connection across invocations within the same
 * Lambda execution context, reducing latency on warm calls.
 */
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });

/**
 * The S3 bucket name is injected by Serverless Framework at deploy time
 * via the environment variable S3_BUCKET_NAME (references the CloudFormation
 * logical resource !Ref UpdatesBucket in serverless.yml).
 */
const BUCKET = process.env.S3_BUCKET_NAME!;

/**
 * Downloads an S3 object and returns its content as a UTF-8 string.
 * Used for reading JSON files: metadata.json, expoConfig.json.
 *
 * S3 GetObject returns a readable stream, not a string directly —
 * we collect all chunks and join them once the stream ends.
 */
export async function getObjectAsString(key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return streamToString(response.Body as any);
}

/**
 * Downloads an S3 object and returns its raw content as a Buffer.
 * Used for reading binary asset files (images, fonts, JS bundles)
 * so we can compute their SHA-256 and MD5 hashes for the manifest.
 */
export async function getObjectAsBuffer(key: string): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return streamToBuffer(response.Body as any);
}

/**
 * Checks whether an object exists at the given S3 key.
 * Used to detect the "rollback" sentinel file — a zero-byte object
 * that signals the manifest handler to return a rollBackToEmbedded
 * directive instead of a normal update manifest.
 *
 * We attempt a full GetObject rather than HeadObject because the Lambda
 * IAM role is scoped to s3:GetObject only (HeadObject is a separate permission).
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists immediate subdirectories under a given S3 prefix.
 * Used to discover all published update timestamps for a runtime version.
 *
 * How it works:
 *   - Delimiter: '/' tells S3 to group keys by the next path segment
 *   - S3 returns these groups as CommonPrefixes (virtual "directories")
 *   - We strip the parent prefix and trailing slash to get just the directory names
 *
 * Example:
 *   prefix = "updates/2/"
 *   S3 has keys: updates/2/1716000000/metadata.json, updates/2/1716500000/metadata.json
 *   CommonPrefixes = ["updates/2/1716000000/", "updates/2/1716500000/"]
 *   Returns: ["1716000000", "1716500000"]
 *
 * The caller (getLatestUpdateBundlePathForRuntimeVersionAsync) then sorts these
 * numerically to find the most recent timestamp.
 */
export async function listDirectories(prefix: string): Promise<string[]> {
  const response = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: '/' }),
  );
  return (response.CommonPrefixes ?? [])
    .map((p) => p.Prefix?.replace(prefix, '').replace('/', '') ?? '')
    .filter(Boolean);
}

/**
 * Uploads a UTF-8 string to S3 at the given key.
 * Used by the logger to write structured JSON log entries.
 */
export async function putObject(key: string, body: string, contentType = 'application/json'): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/**
 * Collects a Node.js readable stream into a single UTF-8 string.
 * Buffers all chunks in memory then decodes once — acceptable for
 * small JSON files (metadata.json, expoConfig.json are typically < 10KB).
 */
function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

/**
 * Collects a Node.js readable stream into a single Buffer.
 * Used for binary assets — we need the raw bytes to compute
 * SHA-256 (integrity hash) and MD5 (asset key/filename) hashes.
 * Lambda has up to 10GB memory so buffering a JS bundle (~1MB) is fine.
 */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
