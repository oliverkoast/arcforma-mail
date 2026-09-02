import AppKit

enum CaptureResult: Equatable {
    case selected(String)
    case none
    case targetChanged
    case copyFailed
    case notTrusted
}

/// Sentinel-clipboard Cmd+C route for hosts whose AX tree is dormant, ported as
/// logic from openwhispr selectionManager.js (_captureViaClipboard). Writes a
/// UUID sentinel, posts Cmd+C, polls every 20 ms for up to 1200 ms for text
/// that is neither the sentinel nor something that was already on the
/// pasteboard, then restores the original only if the pasteboard still holds
/// what we wrote.
///
/// Known limitation, inherited: a pasteboard that already held exactly the
/// selected text reads as "no selection".
enum ClipboardCapture {
    static let pollInterval: TimeInterval = 0.020
    static let timeout: TimeInterval = 1.2
    static let sentinelPrefix = "__ARCFORMA_SELECTION_"
    private static let queue = DispatchQueue(label: "ai.arcforma.text.capture")

    static func capture(expected host: Host, profile: HostProfile,
                        completion: @escaping (CaptureResult) -> Void) {
        guard AXSelection.isTrusted else { completion(.notTrusted); return }
        queue.async {
            let result = captureBlocking(expected: host, profile: profile)
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Synchronous variant for callers already off the main thread. Never call
    /// on the main thread: it sleeps in the poll loop.
    static func captureBlocking(expected host: Host, profile: HostProfile) -> CaptureResult {
        // The frontmost check comes first so a target change never touches the
        // pasteboard at all.
        guard let frontmost = Host.frontmost(), frontmost.pid == host.pid else { return .targetChanged }

        let original = Pasteboard.snapshot()
        var baseline = Set<String>()
        if let before = Pasteboard.currentString() { baseline.insert(before) }
        let sentinel = makeSentinel()
        Pasteboard.write(plain: sentinel, transient: true)
        if let after = Pasteboard.currentString(), after != sentinel { baseline.insert(after) }

        KeySynth.postCommand("c")

        let deadline = Date().addingTimeInterval(timeout)
        var copied: String?
        while Date() < deadline {
            if let text = Pasteboard.currentString(), isCapturedText(text, sentinel: sentinel, baseline: baseline) {
                copied = text
                break
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        restoreIfOurs(original, written: [sentinel, copied].compactMap { $0 }, baseline: baseline)

        guard let copied else { return .none }
        return classify(copied: copied, profile: profile)
    }

    static func makeSentinel() -> String { "\(sentinelPrefix)\(UUID().uuidString)__" }

    /// True when `text` is something Cmd+C produced: non-empty, not our
    /// sentinel, and not anything that was already on the pasteboard.
    static func isCapturedText(_ text: String, sentinel: String, baseline: Set<String>) -> Bool {
        !text.isEmpty && text != sentinel && !baseline.contains(text)
    }

    /// The line-copy editor guard: one line plus a trailing newline from an
    /// editor that copies the whole line on an empty selection means no
    /// selection. Everything else is the selection.
    static func classify(copied: String, profile: HostProfile) -> CaptureResult {
        if profile.lineCopy, isSingleLineWithTerminator(copied) { return .none }
        return .selected(copied)
    }

    /// One line plus a trailing terminator: the shape of an empty-selection
    /// line copy.
    static func isSingleLineWithTerminator(_ text: String) -> Bool {
        // Byte level on purpose: Swift folds "\r\n" into one Character, so
        // String.hasSuffix("\n") misses CRLF line copies.
        let bytes = Array(text.utf8)
        guard bytes.last == 0x0A else { return false }
        var body = bytes.dropLast()
        if body.last == 0x0D { body = body.dropLast() }
        return !body.contains(0x0A)
    }

    /// Restores `original` only when the pasteboard still holds something we
    /// wrote (the sentinel or the copied text). Anything else on it came from
    /// the user during the window and is kept. Returns whether it restored.
    @discardableResult
    static func restoreIfOurs(_ original: PasteboardSnapshot, written: [String], baseline: Set<String>) -> Bool {
        let current = Pasteboard.currentString()
        if let current, !current.isEmpty, !written.contains(current), !baseline.contains(current) {
            // The user copied something while capture was in flight. Keep it.
            return false
        }
        guard let current, written.contains(current) else { return false }
        Pasteboard.restore(original)
        return true
    }
}
