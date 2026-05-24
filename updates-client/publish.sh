#!/bin/bash
set -e

BUCKET="expo-updates-483146682701-ap-south-1"
RUNTIME_VERSION=$(node -e "const a=require('./app.json'); console.log(a.expo.runtimeVersion)")
TIMESTAMP=$(date +%s)
S3_PATH="updates/$RUNTIME_VERSION/$TIMESTAMP"
MODE="${1:-publish}"  # publish | rollback

if [ "$MODE" = "rollback" ]; then
  echo "▶ Triggering rollback for runtimeVersion=$RUNTIME_VERSION..."
  echo -n "" | aws s3 cp - s3://$BUCKET/$S3_PATH/rollback --region ap-south-1

  echo "▶ Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id $(aws cloudfront list-distributions --query "DistributionList.Items[?contains(Origins.Items[].DomainName, '$BUCKET')].Id" --output text) \
    --paths "/api/manifest" \
    --region us-east-1 2>/dev/null || echo "  (skipped — CloudFront invalidation optional)"

  echo ""
  echo "✅ Rollback triggered: https://d2fo0ydrrxggro.cloudfront.net/api/manifest"
  echo "   Runtime version : $RUNTIME_VERSION"
  echo "   S3 path         : $S3_PATH/rollback"
  echo "   Devices will revert to their embedded bundle on next update check."
  exit 0
fi

echo "▶ Exporting app..."
npx expo export --platform android --output-dir dist --no-bytecode

echo "▶ Generating expoConfig.json..."
node -e "
const { getConfig } = require('@expo/config');
const config = getConfig('.', { skipSDKVersionRequirement: true });
console.log(JSON.stringify(config.exp, null, 2));
" > dist/expoConfig.json

echo "▶ Uploading update bundle to S3: $S3_PATH"
aws s3 sync dist/ s3://$BUCKET/$S3_PATH/ --region ap-south-1

# Assets must also be stored at a flat content-addressed path (api/assets/{md5}.{ext})
# because the manifest handler builds URLs pointing to CloudFront /api/assets/*.
# CloudFront routes /api/assets/* directly to S3 — no Lambda involved.
# Without this step, the device gets a 403 when trying to download the JS bundle.
echo "▶ Uploading content-addressed assets to api/assets/..."
node -e "
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

const BUCKET = '$BUCKET';
const REGION = 'ap-south-1';

const mimeTypes = {
  bundle: 'application/javascript',
  js:     'application/javascript',
  png:    'image/png',
  jpg:    'image/jpeg',
  jpeg:   'image/jpeg',
  gif:    'image/gif',
  webp:   'image/webp',
  ttf:    'font/ttf',
  otf:    'font/otf',
  woff:   'font/woff',
  woff2:  'font/woff2',
  svg:    'image/svg+xml',
  json:   'application/json',
};

const metadata = JSON.parse(fs.readFileSync('dist/metadata.json', 'utf-8'));
const { bundle, assets = [] } = metadata.fileMetadata.android;

function upload(relPath, ext, isBundle) {
  const fullPath = path.join('dist', relPath);
  const content = fs.readFileSync(fullPath);
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const keyExt = isBundle ? 'bundle' : ext;
  const contentType = mimeTypes[keyExt] || 'application/octet-stream';
  const s3Key = 'api/assets/' + md5 + '.' + keyExt;
  console.log('  ' + s3Key);
  execSync(
    'aws s3 cp ' + fullPath + ' s3://' + BUCKET + '/' + s3Key +
    ' --region ' + REGION + ' --content-type \"' + contentType + '\"',
    { stdio: 'inherit' }
  );
}

upload(bundle, 'js', true);
for (const asset of assets) upload(asset.path, asset.ext, false);
"

echo "▶ Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id $(aws cloudfront list-distributions --query "DistributionList.Items[?contains(Origins.Items[].DomainName, '$BUCKET')].Id" --output text) \
  --paths "/api/manifest" \
  --region us-east-1 2>/dev/null || echo "  (skipped — CloudFront invalidation optional)"

echo ""
echo "✅ Published to: https://d2fo0ydrrxggro.cloudfront.net/api/manifest"
echo "   Runtime version : $RUNTIME_VERSION"
echo "   Timestamp       : $TIMESTAMP"
