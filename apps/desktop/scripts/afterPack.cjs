// electron-builder afterPack hook: sign the packed .app with the self-signed
// "Arcforma Dev" identity. electron-builder only signs with identities the
// keychain reports as valid, and a self-signed certificate is always
// CSSMERR_TP_NOT_TRUSTED, so the builder skips it and we do it here. Nested
// helpers and frameworks are signed inside-out first so the outer seal stays
// valid; no hardened runtime, no notarization (single-user app).

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const IDENTITY = process.env.CSC_NAME || "Arcforma Dev";

function codesign(target, extra = []) {
  execFileSync("codesign", ["--force", "--sign", IDENTITY, "--timestamp=none", ...extra, target], { stdio: "inherit" });
}

function walkBundles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      if (entry.isFile() && /\.(dylib|node)$/.test(entry.name)) out.push(p);
      continue;
    }
    if (/\.(app|framework|xpc|bundle)$/.test(entry.name)) {
      walkBundles(p, out);
      out.push(p);
    } else if (entry.name !== "Resources" || !/\.app$/.test(path.basename(path.dirname(p)))) {
      walkBundles(p, out);
    }
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${productFilename}.app`);
  if (!fs.existsSync(app)) throw new Error(`afterPack: ${app} not found`);
  const nested = [];
  walkBundles(path.join(app, "Contents"), nested);
  // Innermost first: walkBundles pushes children before their parent bundle.
  for (const target of nested) codesign(target);
  codesign(app);
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
  console.log(`afterPack: signed ${app} as "${IDENTITY}"`);
};
