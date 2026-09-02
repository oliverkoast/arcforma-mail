import AppKit

/// What we know about the app that owns the selection.
struct Host: Equatable {
    var pid: pid_t
    var bundleId: String
    var name: String

    static func frontmost() -> Host? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return Host(pid: app.processIdentifier,
                    bundleId: app.bundleIdentifier ?? "",
                    name: app.localizedName ?? "")
    }

    var isSelf: Bool { pid == ProcessInfo.processInfo.processIdentifier }
}

/// Bundle-id tables and the classification they drive.
enum HostPolicy {

    /// Refuse outright: a synthetic paste into a shell is a command.
    static let terminals: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
        "io.alacritty", "net.kovidgoyal.kitty", "dev.warp.Warp",
    ]

    /// Password managers: never read or replace.
    static let passwordManagers: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
        "com.lastpass.LastPass", "com.dashlane.Dashlane", "com.apple.Passwords",
    ]

    /// Chromium family: AX reads return noValue while the tree is dormant, so
    /// the toolbar shows on the drag heuristic and verifies lazily through the
    /// sentinel clipboard route. Any app whose AX read returns noValue is
    /// treated the same way at runtime.
    static let chromiumAllowlist: Set<String> = [
        "com.google.Chrome", "company.thebrowser.Browser", "com.tinyspeck.slackmacgap",
        "notion.id", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92",
    ]

    /// Editors that copy the whole current line when Cmd+C lands on an empty
    /// selection, so a bare caret looks like a selection to the clipboard route
    /// (openwhispr LINE_COPY_EDITOR_SIGNATURES).
    static let lineCopyEditorBundleIds: Set<String> = [
        "com.microsoft.VSCode", "com.vscodium", "com.todesktop.230313mzl4w4u92",
        "com.exafunction.windsurf", "com.sublimetext.4", "com.sublimetext.3",
    ]
    static let lineCopyEditorSignatures: [String] = [
        "code", "cursor", "windsurf", "sublime", "jetbrains", "intellij", "pycharm", "webstorm",
        "phpstorm", "rider", "android studio", "clion", "goland", "rubymine", "datagrip", "dataspell",
    ]

    /// Hosts whose text areas take native Cmd+B / Cmd+I and paste public.html.
    static let richHosts: Set<String> = [
        "com.apple.Notes", "com.apple.TextEdit", "com.apple.mail", "com.apple.iWork.Pages",
        "com.apple.iWork.Keynote", "com.apple.Stickies", "com.apple.MobileSMS", "com.apple.Safari",
        "com.google.Chrome", "company.thebrowser.Browser", "com.tinyspeck.slackmacgap", "notion.id",
        "com.microsoft.Word", "com.microsoft.Outlook", "org.mozilla.firefox", "com.apple.reminders",
    ]

    /// Code editors are plain even though some sit in the Chromium allowlist.
    static let plainHosts: Set<String> = [
        "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf",
        "com.apple.dt.Xcode", "com.sublimetext.4", "com.sublimetext.3",
    ]

    static func isTerminal(_ bundleId: String) -> Bool { terminals.contains(bundleId) }
    static func isPasswordManager(_ bundleId: String) -> Bool { passwordManagers.contains(bundleId) }
    static func isChromium(_ bundleId: String) -> Bool { chromiumAllowlist.contains(bundleId) }

    static func isLineCopyEditor(bundleId: String, name: String) -> Bool {
        if lineCopyEditorBundleIds.contains(bundleId) { return true }
        let sig = "\(bundleId) \(name)".lowercased()
        if bundleId.lowercased().hasPrefix("com.jetbrains.") { return true }
        return lineCopyEditorSignatures.contains { sig.contains($0) }
    }

    /// Whether Bold, Italic, Bullets, Numbered use native chords and HTML
    /// (rich) or markdown and line prefixes (plain). Unknown hosts are plain;
    /// an AXTextField (single-line field) is plain in any host.
    static func isRich(bundleId: String, axRole: String?) -> Bool {
        if axRole == kAXTextFieldRole { return false }
        if plainHosts.contains(bundleId) { return false }
        return richHosts.contains(bundleId)
    }

    static func profile(for host: Host, axRole: String? = nil, axReturnedNoValue: Bool = false) -> HostProfile {
        HostProfile(
            refused: isTerminal(host.bundleId) || isPasswordManager(host.bundleId) || host.isSelf,
            lazyVerify: isChromium(host.bundleId) || axReturnedNoValue,
            rich: isRich(bundleId: host.bundleId, axRole: axRole),
            lineCopy: isLineCopyEditor(bundleId: host.bundleId, name: host.name)
        )
    }
}

/// The classification a session carries.
struct HostProfile: Equatable {
    /// Terminals, password managers, ourselves. No read, no replace.
    var refused: Bool
    /// Chromium family: toolbar on the drag heuristic, verify via clipboard.
    var lazyVerify: Bool
    /// Native formatting chords and HTML lists.
    var rich: Bool
    /// Empty-selection Cmd+C copies a whole line here.
    var lineCopy: Bool
}
