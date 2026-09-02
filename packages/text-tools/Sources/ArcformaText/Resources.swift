import Foundation

/// Locates the Resources folder (fonts, wordmark). See the note in Package.swift
/// for why this is not Bundle.module.
enum Resources {
    static let directory: URL? = {
        let fm = FileManager.default
        var candidates: [URL] = []
        if let override = ProcessInfo.processInfo.environment["ARCFORMA_TEXT_RESOURCES"] {
            candidates.append(URL(fileURLWithPath: override))
        }
        if let appResources = Bundle.main.resourceURL {
            candidates.append(appResources)
        }
        // Bare binary out of .build/<triple>/<config>/ArcformaText: the package
        // root is three levels up from the binary's directory.
        let exe = URL(fileURLWithPath: CommandInfo.executablePath).resolvingSymlinksInPath()
        let packageRoot = exe.deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        candidates.append(packageRoot.appendingPathComponent("Resources"))
        for url in candidates where fm.fileExists(atPath: url.appendingPathComponent("fonts").path) {
            return url
        }
        return nil
    }()

    /// The SwiftPM package root when the binary runs out of the checkout
    /// (.build/ or build/Arcforma Text.app), found by walking up to
    /// Package.swift. Nil for the installed app. The self-test uses it to scan
    /// the source tree.
    static let packageRoot: URL? = {
        var dir = URL(fileURLWithPath: CommandInfo.executablePath).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("Package.swift").path) { return dir }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }()

    static var fontsDirectory: URL? { directory?.appendingPathComponent("fonts") }
    static var wordmarkURL: URL? { directory?.appendingPathComponent("arcforma-wordmark-ink.svg") }
}

enum CommandInfo {
    static var executablePath: String {
        Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""
    }
}
