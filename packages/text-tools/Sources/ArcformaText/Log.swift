import Foundation
import os

/// Unified log plus an append-only file at ~/Library/Logs/arcforma-text.log.
/// A menu-bar app has nowhere to print, and its failure modes (a denied
/// Accessibility grant, a chord another app already owns, a daemon that is
/// down) are invisible without one.
enum Log {
    private static let logger = Logger(subsystem: "ai.arcforma.text", category: "app")
    private static let queue = DispatchQueue(label: "ai.arcforma.text.log")

    /// Overridable with ARCFORMA_TEXT_LOG so the self-test writes to a temp file
    /// instead of the live log.
    static var fileURL: URL = {
        if let override = ProcessInfo.processInfo.environment["ARCFORMA_TEXT_LOG"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/arcforma-text.log")
    }()

    static func start() {
        let bundle = Bundle.main.bundleIdentifier ?? "ai.arcforma.text (bare binary)"
        write("launch \(bundle) pid \(ProcessInfo.processInfo.processIdentifier) path \(Bundle.main.bundlePath)")
    }

    static func write(_ message: String) {
        logger.log("\(message, privacy: .public)")
        append("INFO  \(message)")
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        append("ERROR \(message)")
    }

    /// Blocks until every queued line has been written. Used by the self-test
    /// before it reads the file back.
    static func flush() {
        queue.sync {}
    }

    private static func append(_ line: String) {
        queue.async {
            let stamp = ISO8601DateFormatter().string(from: Date())
            guard let data = "[\(stamp)] \(line)\n".data(using: .utf8) else { return }
            let url = fileURL
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: url)
            }
        }
    }
}
