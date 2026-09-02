import AppKit

/// Status item, menu, hotkeys, and the three event flows (Cmd+J fix,
/// Cmd+Shift+J instruct, Cmd+Option+J restore) plus the selection toolbar.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {

    private var statusItem: NSStatusItem!
    private var healthItem: NSMenuItem!
    private let fixKey = HotKey()
    private let instructKey = HotKey()
    private let restoreKey = HotKey()
    private let inFlight = InFlightCoordinator()
    private let watcher = SelectionWatcher()
    private let chip = StatusChip.shared
    private var healthTimer: Timer?
    private var healthLine = "AI: checking"
    private var toolbarSession: Session?
    private var toolbarHost: Host?
    private var toolbarProfile: HostProfile?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.start()
        Brand.forceLightAppearance()
        Brand.registerFonts()
        KeySynth.installLayoutObserver()
        buildStatusItem()
        registerHotkeys()
        wireToolbar()
        wireInstructPanel()
        inFlight.onCancel = { [weak self] in
            self?.chip.show("Cancelled", near: nil, for: 0.8)
            Log.write("cancelled by Escape")
        }

        if AXSelection.isTrusted {
            Log.write("accessibility trusted")
        } else {
            // Creates the row in System Settings; the grant itself is manual.
            AXSelection.requestTrust()
            Log.write("accessibility not trusted, prompt requested")
        }
        watcher.start()
        if AIService.shared.forceDirect { Log.write("ai backend forced to direct claude (aiBackend=direct)") }
        refreshHealth()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshHealth() }
    }

    /// Carbon hotkeys die with the process, but an explicit release keeps the
    /// quit path symmetric with launch and cancels any in-flight call.
    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        healthTimer = nil
        inFlight.shutdown()
        fixKey.unregister()
        instructKey.unregister()
        restoreKey.unregister()
        watcher.stop()
        Log.write("quit")
        Log.flush()
    }

    // MARK: Status item

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // F-MAIL-05: SF Symbol placeholder until a standalone brand mark exists.
        let image = NSImage(systemSymbolName: "textformat", accessibilityDescription: "Arcforma Text")
        image?.isTemplate = true
        statusItem.button?.image = image
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(item("Fix selection", #selector(menuFix), Chords.fix))
        menu.addItem(item("Edit with instruction", #selector(menuInstruct), Chords.instruct))
        menu.addItem(item("Restore last", #selector(menuRestore), Chords.restore))
        menu.addItem(.separator())
        healthItem = NSMenuItem(title: healthLine, action: nil, keyEquivalent: "")
        healthItem.isEnabled = false
        menu.addItem(healthItem)
        let ax = NSMenuItem(title: AXSelection.isTrusted ? "Accessibility: granted" : "Accessibility: not granted",
                            action: nil, keyEquivalent: "")
        ax.isEnabled = false
        menu.addItem(ax)
        menu.addItem(.separator())
        menu.addItem(item("Open Accessibility Settings", #selector(openAccessibility), nil))
        menu.addItem(item("Quit", #selector(quit), nil))
        refreshHealth()
    }

    private func item(_ title: String, _ action: Selector, _ chord: Chord?) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        if let chord {
            let (key, flags) = chord.menuKeyEquivalent
            item.keyEquivalent = key
            item.keyEquivalentModifierMask = flags
        }
        return item
    }

    private func refreshHealth() {
        AIService.shared.health { [weak self] _, line in
            guard let self else { return }
            if line != self.healthLine { Log.write(line) }
            self.healthLine = line
            self.healthItem?.title = line
        }
    }

    /// The chip is non-activating on purpose (it must never steal focus from the host app), so it
    /// cannot carry a button. When the refusal is the missing Accessibility grant, open the
    /// settings pane instead, at most once every 20 seconds so repeated presses do not stack windows.
    private var lastAccessibilityEscort = Date.distantPast
    private func escortToAccessibility(if error: ReplaceError) {
        guard case .notTrusted = error else { return }
        guard Date().timeIntervalSince(lastAccessibilityEscort) > 20 else { return }
        lastAccessibilityEscort = Date()
        Log.write("accessibility missing, opening System Settings")
        openAccessibility()
    }

    @objc private func openAccessibility() {
        if !AXSelection.isTrusted { AXSelection.requestTrust() }
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func menuFix() { runFix() }
    @objc private func menuInstruct() { runInstruct() }
    @objc private func menuRestore() { runRestore() }

    // MARK: Hotkeys

    private func registerHotkeys() {
        let fix = Chords.fix, instruct = Chords.instruct, restore = Chords.restore
        let ok1 = fixKey.register(fix) { [weak self] in self?.runFix() }
        let ok2 = instructKey.register(instruct) { [weak self] in self?.runInstruct() }
        let ok3 = restoreKey.register(restore) { [weak self] in self?.runRestore() }
        Log.write("hotkeys: fix \(fix.label) \(ok1 ? "ok" : "FAILED"), instruct \(instruct.label) \(ok2 ? "ok" : "FAILED"), restore \(restore.label) \(ok3 ? "ok" : "FAILED")")
    }

    // MARK: Flows

    private func runFix() {
        guard !inFlight.isActive else { Log.write("fix: ignored, a call is already in flight"); return }
        watcher.dismiss()
        closeInstructPanel()
        chip.show("Fixing", near: nil)
        let started = Date()
        Replacer.shared.capture { [weak self] result in
            guard let self else { return }
            let captureMs = Int(Date().timeIntervalSince(started) * 1000)
            switch result {
            case .failure(let error):
                Log.write("fix: refused after \(captureMs) ms: \(error.chipText) (\(error))")
                self.finish("fix", .failure(.replace(error)), near: nil)
                self.escortToAccessibility(if: error)
            case .success(let session):
                Log.write("fix: captured \(session.original.count) chars from \(session.host.bundleId) via \(session.route) in \(captureMs) ms")
                self.chip.move(near: session.bounds)
                self.run(Actions.fix, session: session, instruction: nil, captureMs: captureMs)
            }
        }
    }

    private func runInstruct() {
        guard !inFlight.isActive else { Log.write("instruct: ignored, a call is already in flight"); return }
        watcher.dismiss()
        let started = Date()
        Replacer.shared.capture { [weak self] result in
            guard let self else { return }
            let captureMs = Int(Date().timeIntervalSince(started) * 1000)
            switch result {
            case .failure(let error):
                Log.write("instruct: refused after \(captureMs) ms: \(error.chipText) (\(error))")
                self.chip.show(error.chipText, near: nil, for: 1.2)
                self.escortToAccessibility(if: error)
            case .success(let session):
                Log.write("instruct: captured \(session.original.count) chars from \(session.host.bundleId) via \(session.route) in \(captureMs) ms")
                self.openInstruct(for: session, captureMs: captureMs)
            }
        }
    }

    private var instructCaptureMs = 0

    private func openInstruct(for session: Session, captureMs: Int) {
        toolbarSession = session
        instructCaptureMs = captureMs
        InstructPanel.shared.present(above: session.bounds)
    }

    private func closeInstructPanel() {
        guard InstructPanel.shared.isVisible else { return }
        InstructPanel.shared.dismiss()
        toolbarSession = nil
    }

    private func wireInstructPanel() {
        InstructPanel.shared.onSubmit = { [weak self] instruction in
            guard let self, let session = self.toolbarSession else { return }
            let captureMs = self.instructCaptureMs
            // Let the host regain key status before the paste lands.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                guard let self else { return }
                self.chip.show("Editing", near: session.bounds)
                self.run(Actions.instruct, session: session, instruction: instruction, captureMs: captureMs)
            }
        }
        InstructPanel.shared.onCancel = { [weak self] in self?.toolbarSession = nil }
    }

    private func runRestore() {
        watcher.dismiss()
        closeInstructPanel()
        guard let last = Replacer.shared.last, last.isFresh else {
            Log.write("restore: nothing to restore")
            chip.show("Nothing to restore", near: nil, for: 1.2); return
        }
        Replacer.shared.restoreLast { [weak self] result in
            switch result {
            case .success(let text):
                Log.write("restore: \(text)")
                self?.chip.show(text, near: nil, for: 0.8)
            case .failure(let error):
                Log.write("restore: refused: \(error.chipText) (\(error))")
                self?.chip.show(error.chipText, near: nil, for: 1.2)
            }
        }
    }

    private func run(_ action: TextAction, session: Session, instruction: String?, captureMs: Int) {
        let generation = inFlight.nextGeneration()
        var ctx = ActionContext(session: session, instruction: instruction)
        ctx.captureMs = captureMs
        ctx.status = { [weak self] text in self?.chip.show(text, near: session.bounds) }
        ctx.register = { [weak self] handle in self?.inFlight.begin(handle, generation: generation) }
        action.perform(ctx) { [weak self] result in
            guard let self else { return }
            self.inFlight.end(generation: generation)
            self.finish(action.id, result, near: session.bounds)
        }
    }

    private func finish(_ label: String, _ result: Result<ActionOutcome, ActionFailure>, near rect: CGRect?) {
        switch result {
        case .success(.replaced):
            Log.write("\(label): Done")
            chip.show("Done", near: rect, for: 0.8)
        case .success(.unchanged):
            Log.write("\(label): No changes")
            chip.show("No changes", near: rect, for: 1.2)
        case .success(.restored(let text)):
            Log.write("\(label): \(text)")
            chip.show(text, near: rect, for: 0.8)
        case .success(.delegated):
            Log.write("\(label): delegated to host")
            chip.hide()
        case .failure(.ai(.cancelled)):
            break
        case .failure(let error):
            Log.write("\(label): \(error.chipText) (\(error))")
            chip.show(error.chipText, near: rect, for: 1.4)
        }
    }

    // MARK: Toolbar

    private func wireToolbar() {
        watcher.onSelection = { [weak self] session, host, profile, rect in
            guard let self else { return }
            self.toolbarSession = session
            self.toolbarHost = host
            self.toolbarProfile = profile
            let actions = Actions.toolbar.filter { $0.isAvailable(profile) }
            guard !actions.isEmpty else { return }
            ToolbarPanel.shared.present(actions: actions, above: rect)
        }
        watcher.onDismiss = { ToolbarPanel.shared.dismiss() }
        watcher.onOutsideMouseDown = { [weak self] in self?.closeInstructPanel() }
        ToolbarPanel.shared.onSelect = { [weak self] action in
            guard let self else { return }
            let session = self.toolbarSession
            self.watcher.dismiss()
            if let session {
                self.dispatch(action, session: session, captureMs: 0)
            } else {
                // Chromium host: verify lazily through the clipboard route.
                let started = Date()
                Replacer.shared.capture { [weak self] result in
                    guard let self else { return }
                    let captureMs = Int(Date().timeIntervalSince(started) * 1000)
                    switch result {
                    case .failure(let error):
                        // Empty result dismisses silently; the log still says why.
                        Log.write("toolbar \(action.id): lazy verify refused after \(captureMs) ms: \(error)")
                    case .success(let session):
                        self.dispatch(action, session: session, captureMs: captureMs)
                    }
                }
            }
        }
    }

    private func dispatch(_ action: TextAction, session: Session, captureMs: Int) {
        if action.id == Actions.instruct.id {
            openInstruct(for: session, captureMs: captureMs)
        } else {
            run(action, session: session, instruction: nil, captureMs: captureMs)
        }
    }
}
