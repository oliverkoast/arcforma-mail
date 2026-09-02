#!/bin/bash
# Creates the self-signed "Arcforma Dev" codesign identity in the login
# keychain (the clipstack "ClipStack Dev" recipe). Run once per machine. The
# certificate shows as CSSMERR_TP_NOT_TRUSTED in `security find-identity`,
# which is expected and does not prevent signing.
set -euo pipefail
NAME="${1:-Arcforma Dev}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"
openssl pkcs12 -export -inkey key.pem -in cert.pem -out identity.p12 \
  -name "$NAME" -passout pass:arcforma \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
security import identity.p12 -k ~/Library/Keychains/login.keychain-db \
  -P arcforma -T /usr/bin/codesign
echo "Imported '$NAME'. Verify with: security find-identity -p codesigning"
