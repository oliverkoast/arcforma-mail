import AppKit

/// Mouse-driven selection detection for the toolbar. Global NSEvent monitors
/// for mouse events need no TCC; the AX read that follows needs Accessibility.
///
/// Fires on mouse-up after a drag over 6 pt, or a double or triple click, then
/// waits 150 ms and reads AXSelectedText. Shows for 2 to 6000 code points.
/// Hides on mouse-down outside, scroll, app activation, and a 250 ms AX poll
/// that notices the selection changing. Chromium hosts (no AX value) show on
/// the drag heuristic with a 12 s timeout and verify lazily when a button is
/// clicked. Never in terminals, secure fields, password managers, or our own
/// process. Keyboard-only selections never show the toolbar.
final class SelectionWatcher {
    static let dragThreshold: CGFloat = 6
    static let settleDelay: TimeInterval = 0.15
    static let pollInterval: TimeInterval = 0.25
    static let chromiumTimeout: TimeInterval = 12
    static let minCodePoints = 2

    /// A session with text, or nil for a Chromium host that verifies lazily.
    var onSelection: ((Session?, Host, HostProfile, CGRect?) -> Void)?
    var onDismiss: (() -> Void)?
    /// Any left mouse-down outside our own windows (global monitors never see
    /// events in our panels). The instruct panel closes on it.
    var onOutsideMouseDown: (() -> Void)?

    private var monitors: [Any] = []
    private var dragStart: CGPoint?
    private var dragged = false
    private var pending: DispatchWorkItem?
    private var poll: Timer?
    private var visibleSession: Session?
    private var visibleSince: Date?
    private var visibleHost: Host?
    private(set) var isShowing = false

    func start() {
        guard monitors.isEmpty else { return }
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
            self?.mouseDown(e)
        } as Any)
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDragged) { [weak self] e in
            self?.mouseDragged(e)
        } as Any)
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] e in
            self?.mouseUp(e)
        } as Any)
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] _ in
            self?.dismiss()
        } as Any)
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appActivated), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        Log.write("selection watcher started")
    }

    func stop() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        dismiss()
    }

    // MARK: Events (global monitors never see events in our own windows)

    private func mouseDown(_ event: NSEvent) {
        dragStart = NSEvent.mouseLocation
        dragged = false
        pending?.cancel()
        if isShowing { dismiss() }
        onOutsideMouseDown?()
    }

    private func mouseDragged(_ event: NSEvent) {
        guard let start = dragStart, !dragged else { return }
        let now = NSEvent.mouseLocation
        if hypot(now.x - start.x, now.y - start.y) >= SelectionWatcher.dragThreshold { dragged = true }
    }

    private func mouseUp(_ event: NSEvent) {
        let multiClick = event.clickCount >= 2
        guard dragged || multiClick else { return }
        dragged = false
        let point = NSEvent.mouseLocation
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.evaluate(at: point) }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + SelectionWatcher.settleDelay, execute: work)
    }

    @objc private func appActivated(_ note: Notification) {
        if isShowing { dismiss() }
    }

    // MARK: Evaluate

    private func evaluate(at point: CGPoint) {
        guard AXSelection.isTrusted, let host = Host.frontmost(), !host.isSelf else { return }
        if HostPolicy.isTerminal(host.bundleId) || HostPolicy.isPasswordManager(host.bundleId) { return }

        let element = AXSelection.focusedElement(pid: host.pid, attempts: 1)
        let role = element.flatMap { AXSelection.role(of: $0) }
        let read: AXReadResult = element.map { AXSelection.read(element: $0) } ?? .unavailable(-1)
        let fallbackRect = CGRect(x: point.x, y: point.y + 12, width: 0, height: 0)

        switch read {
        case .secure:
            return
        case .text(let text):
            let count = text.unicodeScalars.count
            guard count >= SelectionWatcher.minCodePoints, count <= Session.maxCodePoints else { return }
            let profile = HostPolicy.profile(for: host, axRole: role)
            let bounds = element.flatMap { AXSelection.selectionBounds(element: $0) }
            let session = Session(original: text, host: host, profile: profile, route: .ax,
                                  axRole: role, bounds: bounds)
            show(session: session, host: host, profile: profile, rect: bounds ?? fallbackRect)
        case .empty:
            if HostPolicy.isChromium(host.bundleId) {
                let profile = HostPolicy.profile(for: host, axRole: role, axReturnedNoValue: false)
                show(session: nil, host: host, profile: profile, rect: fallbackRect)
            }
        case .noValue, .unavailable:
            // Dormant AX tree. Allowlisted Chromium apps show on the drag
            // heuristic; anything else we cannot read stays quiet.
            guard HostPolicy.isChromium(host.bundleId) else { return }
            let profile = HostPolicy.profile(for: host, axRole: role, axReturnedNoValue: true)
            show(session: nil, host: host, profile: profile, rect: fallbackRect)
        }
    }

    private func show(session: Session?, host: Host, profile: HostProfile, rect: CGRect?) {
        visibleSession = session
        visibleHost = host
        visibleSince = Date()
        isShowing = true
        onSelection?(session, host, profile, rect)
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: SelectionWatcher.pollInterval, repeats: true) { [weak self] _ in
            self?.pollSelection()
        }
    }

    private func pollSelection() {
        guard isShowing, let host = visibleHost else { return }
        guard Host.frontmost()?.pid == host.pid else { dismiss(); return }
        if let session = visibleSession {
            if case .text(let now) = AXSelection.read(pid: host.pid, attempts: 1), now == session.original { return }
            dismiss()
        } else if let since = visibleSince, Date().timeIntervalSince(since) > SelectionWatcher.chromiumTimeout {
            dismiss()
        }
    }

    func dismiss() {
        guard isShowing else { return }
        isShowing = false
        poll?.invalidate()
        poll = nil
        visibleSession = nil
        visibleHost = nil
        onDismiss?()
    }
}
