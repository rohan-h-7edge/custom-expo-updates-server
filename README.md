# Custom Expo Updates Server

Production-ready OTA (Over-The-Air) update server for Expo apps built on AWS serverless infrastructure. Implements the [Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1).

---

## Architecture

```
Mobile App (expo-updates)
        │
        ▼
  CloudFront (CDN)
        │
        ├─ /api/manifest ──▶ API Gateway ──▶ Lambda ──▶ S3 (reads metadata)
        │                                         │
        │                                   Secrets Manager (signing key)
        │
        └─ /api/assets/* ──▶ S3 directly (no Lambda, cached 1 year)
```

| Component | Technology |
|---|---|
| Manifest API | AWS Lambda (Node.js 22) |
| Asset storage | AWS S3 |
| CDN | AWS CloudFront |
| Code signing key | AWS Secrets Manager |
| Infrastructure | Serverless Framework v4 |
| Client | Expo SDK 56 + expo-updates |

---

## Folder Structure

```
custom-expo-updates-server/
├── package.json                        # npm workspace root
│
├── server/                             # Lambda backend
│   ├── serverless.yml                  # Infrastructure: Lambda, API Gateway, S3, CloudFront
│   ├── tsconfig.json
│   ├── src/
│   │   ├── handlers/
│   │   │   └── manifest.ts             # Lambda entry point — expo-updates manifest protocol
│   │   └── lib/
│   │       ├── helpers.ts              # Manifest building, S3 path resolution, directives
│   │       ├── s3.ts                   # S3 client (get, put, list, exists)
│   │       ├── logger.ts               # Writes per-request JSON logs to S3
│   │       └── signing.ts              # RSA-SHA256 code signing via Secrets Manager
│   ├── events/
│   │   └── manifest-get.json           # Test event for local sls invoke
│   └── __tests__/
│
└── updates-client/                     # Expo React Native app
    ├── App.js                          # Main screen
    ├── app.json                        # Points updates.url to CloudFront manifest
    ├── metro.config.js                 # Workspace-aware Metro config
    ├── index.js
    ├── publish.sh                      # OTA publish + rollback script
    ├── code-signing/
    │   └── certificate.pem             # Public cert bundled in app (verifies signed manifests)
    └── assets/                         # Icons, splash screens
```

---

## Prerequisites

- Node.js 18+
- AWS CLI configured (`aws configure`)
- Serverless Framework v4 (`npm i -g serverless`)

---

## New Project Setup

Follow these steps in order when setting up this server for a new app.

### 1. Clone & install

```bash
git clone <repo>
cd custom-expo-updates-server
npm install
```

### 2. Generate code signing key pair

```bash
cd updates-client
npx expo-updates codesigning:generate \
  --key-output-directory ../keys \
  --certificate-output-directory code-signing \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "Your App Name"
```

| Output | What to do |
|---|---|
| `code-signing/certificate.pem` | Commit this — bundled into the app |
| `keys/private-key.pem` | **Never commit** — upload to Secrets Manager (next step) |

### 3. Upload private key to Secrets Manager

```bash
aws secretsmanager create-secret \
  --name "expo-updates/code-signing-private-key" \
  --secret-string file://../keys/private-key.pem \
  --region ap-south-1
```

Copy the returned `ARN` for the next two steps.

### 4. Update `server/serverless.yml`

Replace the secret ARN in **both** places (environment + IAM resource):

```yaml
org: your-org-name
app: your-app-name

PRIVATE_KEY_SECRET_ARN: arn:aws:secretsmanager:ap-south-1:YOUR_ACCOUNT:secret:expo-updates/...
```

### 5. Update `updates-client/app.json`

```json
{
  "expo": {
    "name": "your-app-name",
    "slug": "your-app-slug",
    "runtimeVersion": "1",
    "ios": { "bundleIdentifier": "com.yourcompany.appname" },
    "android": { "package": "com.yourcompany.appname" }
  }
}
```

### 6. Deploy to AWS

```bash
cd server
sls deploy
```

From the outputs, copy `ManifestEndpoint` (e.g. `https://xxxx.cloudfront.net/api/manifest`) and set it in `updates-client/app.json` → `expo.updates.url`.

### 7. Update `updates-client/publish.sh`

```bash
BUCKET="expo-updates-YOUR_ACCOUNT_ID-ap-south-1"   # line 4
```

### 8. Create `server/.env.local` for local development

```bash
AWS_REGION=ap-south-1
S3_BUCKET_NAME=expo-updates-YOUR_ACCOUNT_ID-ap-south-1
PRIVATE_KEY_SECRET_ARN=arn:aws:secretsmanager:...
ASSETS_BASE_URL=http://localhost:3000
```

### 9. Build the native app

```bash
cd updates-client
npx expo run:android    # or run:ios
```

This bakes the `runtimeVersion` and `updates.url` into the native binary.

### 10. Publish your first OTA update

```bash
./publish.sh
```

### Files to change per project

| File | What to update |
|---|---|
| `server/serverless.yml` | `org`, `app`, `PRIVATE_KEY_SECRET_ARN` (×2) |
| `server/.env.local` | `S3_BUCKET_NAME`, `PRIVATE_KEY_SECRET_ARN` |
| `updates-client/app.json` | `name`, `slug`, `updates.url`, bundle IDs, `runtimeVersion` |
| `updates-client/publish.sh` | `BUCKET` |
| `updates-client/code-signing/certificate.pem` | Replace with newly generated cert |

---

## Existing Project Setup

### 1. Install dependencies

```bash
npm install          # installs all workspaces from repo root
```

### 2. Deploy to AWS

```bash
cd server
sls deploy
```

Note the outputs — copy `CloudFrontURL` into `updates-client/app.json` → `expo.updates.url`.

---

## Publishing an Update

```bash
cd updates-client
./publish.sh            # export → upload to S3 → invalidate CloudFront
```

### Rollback (revert all devices to embedded bundle)

```bash
./publish.sh rollback
```

This uploads a zero-byte `rollback` sentinel to a new timestamp directory. All devices revert to the JS bundle baked into their native binary on the next update check. To recover, run `./publish.sh` again with a fix.

---

## S3 Structure

```
s3://expo-updates-<accountId>-ap-south-1/
├── updates/
│   └── {runtimeVersion}/              e.g. "1"
│       └── {unix-timestamp}/          highest timestamp = latest update
│           ├── metadata.json
│           ├── expoConfig.json
│           ├── bundles/
│           │   └── android-<hash>.js
│           └── assets/
│
├── api/
│   └── assets/
│       └── {md5}.{ext}                content-addressed flat namespace
│                                      served directly by CloudFront → S3
└── logs/
    └── {YYYY-MM-DD}/
        └── {timestamp}_{requestId}.json   per-request manifest logs
```

---

## Request Logs

Every manifest request writes a structured JSON log to `s3://…/logs/YYYY-MM-DD/`.

```json
{
  "requestId": "abc123",
  "timestamp": "2026-05-24T10:00:00.000Z",
  "platform": "android",
  "runtimeVersion": "1",
  "currentUpdateId": "xxxxxxxx-…",
  "outcome": "update_served",
  "statusCode": 200,
  "updateBundlePath": "updates/1/1716000000",
  "manifestId": "xxxxxxxx-…"
}
```

| `outcome` | Meaning |
|---|---|
| `update_served` | New update sent to device |
| `no_update` | Device already has latest |
| `rollback` | Rollback directive sent |
| `not_found` | No update for this `runtimeVersion` |
| `bad_request` | Missing or invalid headers |
| `error` | Unexpected server error |

```bash
# View today's logs
aws s3 sync s3://expo-updates-483146682701-ap-south-1/logs/$(date +%Y-%m-%d)/ /tmp/expo-logs/ --region ap-south-1
cat /tmp/expo-logs/*.json
```

---

## Local Development

```bash
cd server
cp .env.local.example .env.local    # fill in bucket name, secret ARN, etc.

# Invoke the handler directly
sls invoke local -f manifest -p events/manifest-get.json

# Run a local HTTP server
sls offline
# → http://localhost:3000/api/manifest
```

### Environment Variables

| Variable | Description |
|---|---|
| `S3_BUCKET_NAME` | Resolved from CloudFormation at deploy time |
| `PRIVATE_KEY_SECRET_ARN` | ARN of the Secrets Manager secret |
| `ASSETS_BASE_URL` | CloudFront domain (or `http://localhost:3000` locally) |

---

## Code Signing

Manifests are signed with RSA-SHA256. The private key lives in Secrets Manager. The matching public certificate is bundled in the client at `code-signing/certificate.pem`. If the signature doesn't verify, `expo-updates` rejects the update entirely.

To generate a new key pair:

```bash
npx expo-updates codesigning:generate \
  --key-output-directory keys \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "Expo Updates"
```

---

## Security

| Threat | Mitigation |
|---|---|
| Malicious update injection | RSA-SHA256 code signing verified on device |
| Private key exposure | Stored in Secrets Manager, never in code |
| Direct S3 access | CloudFront OAC — S3 rejects all direct requests |
| Stale manifest cache | `cache-control: private, max-age=0` on every manifest response |
| Asset tampering | Content-addressed keys + hash verified by expo-updates |
| Over-privileged Lambda | IAM role scoped to one bucket + one secret ARN |
