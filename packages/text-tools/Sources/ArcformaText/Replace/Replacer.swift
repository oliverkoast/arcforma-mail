import AppKit

/// Why a capture or replace was refused. Every path fails closed: no paste
/// unless the selection is re-read and matches the session.
enum ReplaceError: Error, Equatable {
    case notTrusted
    case noFrontmostApp
    case ownProcess
    case terminalRefused
    case secureField
    case noSelection
    case tooLong
    case hostChanged
    case selectionChanged
    case captureFailed
    case emptyReplacement

    /// Chip copy. Buttons and chips say what happens.
    var chipText: String {
        switch self {
        case .notTrusted: return "Grant Accessibility"
        case .noSelection, .noFrontmostApp: return "Select text first"
        case .terminalRefused: return "Not in terminals"
        case .secureField: return "Not in password fields"
        case .tooLong: return "Selection too long"
        case .hostChanged, .selectionChanged: return "Selection changed"
        case .captureFailed: return "Could not read selection"
        case .emptyReplacement: return "No changes"
        case .ownProcess: return "Select text first"
        }
    }

    static let allCases: [ReplaceError] = [.notTrusted, .noFrontmostApp, .ownProcess, .terminalRefused, .secureField,
                                           .noSelection, .tooLong, .hostChanged, .selectionChanged, .captureFailed,
                                           .emptyReplacement]
}

enum CaptureRoute: Equatable { case ax, clipboard }

/// One captured selection. Replace is only allowed against a session whose
/// selection still reads the same.
struct Session: Equatable {
    static let ttl: TimeInterval = 5 * 60
    static let maxCodePoints = 6000

    let id = UUID()
    var original: String
    var host: Host
    var profile: HostProfile
    var route: CaptureRoute
    var axRole: String?
    var bounds: CGRect?
    var createdAt = Date()

    var isExpired: Bool { Date().timeIntervalSince(createdAt) > Session.ttl }
}

struct LastReplacement {
    static let memory: TimeInterval = 30
    var original: String
    var replacement: String
    var host: Host
    var at: Date
    var isFresh: Bool { Date().timeIntervalSince(at) <= LastReplacement.memory }
}

/// capture -> session -> verify -> replace, ported as logic from openwhispr
/// selectionManager.js. Paste mechanics from clipstack Paster.swift.
final class Replacer {
    static let shared = Replacer()

    private(set) var last: LastReplacement?
    static let restoreDelay: TimeInterval = 0.35

    // MARK: Capture

    /// Reads the frontmost selection. AX first; the sentinel clipboard route
    /// when the host reports noValue (Chromium family) or sits on the allowlist.
    func capture(completion: @escaping (Result<Session, ReplaceError>) -> Void) {
        guard AXSelection.isTrusted else { completion(.failure(.notTrusted)); return }
        guard let host = Host.frontmost() else { completion(.failure(.noFrontmostApp)); return }
        if host.isSelf { completion(.failure(.ownProcess)); return }
        if HostPolicy.isTerminal(host.bundleId) { completion(.failure(.terminalRefused)); return }
        if HostPolicy.isPasswordManager(host.bundleId) { completion(.failure(.secureField)); return }

        let element = AXSelection.focusedElement(pid: host.pid)
        let role = element.flatMap { AXSelection.role(of: $0) }
        let read: AXReadResult = element.map { AXSelection.read(element: $0) } ?? .unavailable(-1)
        let bounds = element.flatMap { AXSelection.selectionBounds(element: $0) }

        switch read {
        case .secure:
            completion(.failure(.secureField))
        case .text(let text):
            let profile = HostPolicy.profile(for: host, axRole: role)
            completion(Replacer.validate(Session(original: text, host: host, profile: profile,
                                                 route: .ax, axRole: role, bounds: bounds)))
        case .empty:
            // AX answered and the selection is empty. Chromium hosts can still
            // report an empty string with a real selection in a web view, so
            // only they get the clipboard route.
            if HostPolicy.isChromium(host.bundleId) {
                captureViaClipboard(host: host, role: role, bounds: bounds, noValue: false, completion: completion)
            } else {
                completion(.failure(.noSelection))
            }
        case .noValue, .unavailable:
            captureViaClipboard(host: host, role: role, bounds: bounds, noValue: true, completion: completion)
        }
    }

    private func captureViaClipboard(host: Host, role: String?, bounds: CGRect?, noValue: Bool,
                                     completion: @escaping (Result<Session, ReplaceError>) -> Void) {
        let profile = HostPolicy.profile(for: host, axRole: role, axReturnedNoValue: noValue)
        ClipboardCapture.capture(expected: host, profile: profile) { result in
            switch result {
            case .selected(let text):
                completion(Replacer.validate(Session(original: text, host: host, profile: profile,
                                                     route: .clipboard, axRole: role, bounds: bounds)))
            case .none: completion(.failure(.noSelection))
            case .targetChanged: completion(.failure(.hostChanged))
            case .copyFailed: completion(.failure(.captureFailed))
            case .notTrusted: completion(.failure(.notTrusted))
            }
        }
    }

    static func validate(_ session: Session) -> Result<Session, ReplaceError> {
        if session.original.unicodeScalars.count > Session.maxCodePoints { return .failure(.tooLong) }
        if session.original.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .failure(.noSelection) }
        return .success(session)
    }

    // MARK: Verify

    /// Re-reads the selection through the session's route and compares it to
    /// the original. Anything else fails closed.
    func verify(_ session: Session, completion: @escaping (Result<Void, ReplaceError>) -> Void) {
        guard !session.isExpired else { completion(.failure(.selectionChanged)); return }
        guard let frontmost = Host.frontmost(), frontmost.pid == session.host.pid else {
            completion(.failure(.hostChanged)); return
        }
        switch session.route {
        case .ax:
            let read = AXSelection.read(pid: session.host.pid)
            if case .text(let now) = read, now == session.original {
                completion(.success(()))
            } else {
                Log.write("verify: AX re-read differs (\(read == .noValue ? "noValue" : "changed"))")
                completion(.failure(.selectionChanged))
            }
        case .clipboard:
            ClipboardCapture.capture(expected: session.host, profile: session.profile) { result in
                if case .selected(let now) = result, now == session.original {
                    completion(.success(()))
                } else {
                    Log.write("verify: clipboard re-read differs (\(result))")
                    completion(.failure(.selectionChanged))
                }
            }
        }
    }

    // MARK: Replace

    /// Verify, then paste `plain` (plus an optional public.html flavor) over the
    /// selection. Records the replacement for Cmd+Option+J.
    func replace(_ session: Session, plain: String, html: String? = nil,
                 completion: @escaping (Result<Void, ReplaceError>) -> Void) {
        guard !plain.isEmpty else { completion(.failure(.emptyReplacement)); return }
        verify(session) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { completion(.failure(error)); return }
            self.paste(plain: plain, html: html, into: session.host) { ok in
                if ok {
                    self.last = LastReplacement(original: session.original, replacement: plain,
                                                host: session.host, at: Date())
                    Log.write("replaced \(session.original.count) -> \(plain.count) chars in \(session.host.bundleId) via \(session.route)")
                    completion(.success(()))
                } else {
                    completion(.failure(.hostChanged))
                }
            }
        }
    }

    /// Save every flavor, write the replacement marked transient, post Cmd+V,
    /// restore after 350 ms only if the changeCount is still ours.
    func paste(plain: String, html: String?, into host: Host, completion: @escaping (Bool) -> Void) {
        let saved = Pasteboard.snapshot()
        let ours = Pasteboard.write(plain: plain, html: html, transient: true)
        Replacer.ensureFrontmost(host) { frontmost in
            guard frontmost else {
                Pasteboard.restoreIfOurs(saved, ours: ours)
                completion(false)
                return
            }
            // Give the host a beat to read the fresh pasteboard.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) {
                KeySynth.postCommand("v")
                DispatchQueue.main.asyncAfter(deadline: .now() + Replacer.restoreDelay) {
                    if !Pasteboard.restoreIfOurs(saved, ours: ours) {
                        Log.write("paste: pasteboard changed under us, leaving it alone")
                    }
                    completion(true)
                }
            }
        }
    }

    /// Activate `host` only if it is not already frontmost (re-activating an
    /// active Chromium app drops its field's first responder), then poll until
    /// the OS reports it frontmost. From openwhispr textEditMonitor.js.
    static func ensureFrontmost(_ host: Host, completion: @escaping (Bool) -> Void) {
        if Host.frontmost()?.pid == host.pid { completion(true); return }
        guard let app = NSRunningApplication(processIdentifier: host.pid) else { completion(false); return }
        app.activate()
        var remaining = 6
        func poll() {
            if Host.frontmost()?.pid == host.pid { completion(true); return }
            remaining -= 1
            if remaining <= 0 { Log.write("activate: \(host.bundleId) did not become frontmost"); completion(false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: poll)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: poll)
    }

    // MARK: Restore

    /// Cmd+Option+J. If the current selection equals the last replacement,
    /// paste the original back through the replace path; otherwise post the
    /// host's own Cmd+Z.
    func restoreLast(completion: @escaping (Result<String, ReplaceError>) -> Void) {
        guard let last, last.isFresh else { completion(.failure(.noSelection)); return }
        capture { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let session) where session.host.pid == last.host.pid && session.original == last.replacement:
                self.replace(session, plain: last.original) { r in
                    switch r {
                    case .success:
                        self.last = nil
                        completion(.success("Restored"))
                    case .failure(let e): completion(.failure(e))
                    }
                }
            case .success, .failure(.noSelection):
                guard let frontmost = Host.frontmost(), frontmost.pid == last.host.pid,
                      !HostPolicy.isTerminal(frontmost.bundleId) else {
                    completion(.failure(.hostChanged)); return
                }
                KeySynth.postCommand("z")
                self.last = nil
                completion(.success("Undone"))
            case .failure(let e):
                completion(.failure(e))
            }
        }
    }
}
