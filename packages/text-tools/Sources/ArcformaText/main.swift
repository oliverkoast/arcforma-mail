import AppKit

// `ArcformaText --selftest` prints environment state and runs the pure-logic
// checks, then exits. `--e2e-status` prints what the e2e harness needs to
// decide whether it can run (Accessibility, backend, claude binary) and exits
// 0 only when Accessibility is granted. Everything else is the menu-bar app.
if CommandLine.arguments.contains("--selftest") {
    exit(SelfTest.run())
}
if CommandLine.arguments.contains("--e2e-status") {
    // Run from a terminal, TCC attributes this process to the terminal, so
    // the trust value here is the terminal's. The launchd-run app logs its
    // own answer at launch ("accessibility trusted"); the harness reads that.
    let trusted = AXSelection.isTrusted
    print("accessibility trusted: \(trusted)")
    print("ai backend: \(AIService.shared.forceDirect ? "direct" : "daemon first")")
    print("claude binary: \(AIService.shared.cli.binary) installed=\(AIService.shared.cli.isInstalled)")
    print("log file: \(Log.fileURL.path)")
    exit(trusted ? 0 : 1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
