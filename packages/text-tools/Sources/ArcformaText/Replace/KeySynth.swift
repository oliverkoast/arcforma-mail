import AppKit
import Carbon.HIToolbox

/// Synthetic Cmd+<key> events with layout-resolved key codes, from clipstack
/// Paster.swift. Hard-coding `kVK_ANSI_V` sends Cmd+K on Dvorak, because
/// virtual key codes are physical positions and apps match Cmd shortcuts on
/// the resulting character. Translating each key code through the active
/// layout fixes that.
enum KeySynth {

    private static var cache: [Character: CGKeyCode] = [:]
    private static var observerInstalled = false

    /// Drop the cache when the keyboard layout changes.
    static func installLayoutObserver() {
        guard !observerInstalled else { return }
        observerInstalled = true
        NotificationCenter.default.addObserver(
            forName: NSTextInputContext.keyboardSelectionDidChangeNotification,
            object: nil, queue: .main) { _ in cache.removeAll() }
    }

    /// Finds the key code that types `character` under the current layout.
    static func keyCode(for character: Character) -> CGKeyCode? {
        let wanted = String(character).lowercased()
        if let cached = cache[character] { return cached }
        guard let layoutData = currentLayoutData() else { return nil }
        var found: CGKeyCode?
        layoutData.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
            var deadKeys: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            for code in 0..<CGKeyCode(128) {
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0,
                                            UInt32(LMGetKbdType()), UInt32(kUCKeyTranslateNoDeadKeysBit),
                                            &deadKeys, chars.count, &length, &chars)
                guard status == noErr, length == 1 else { continue }
                if String(utf16CodeUnits: chars, count: 1).lowercased() == wanted {
                    found = code
                    return
                }
            }
        }
        if let found { cache[character] = found }
        return found
    }

    /// The character a key code produces under the current layout.
    static func character(for code: CGKeyCode) -> String? {
        let named: [Int: String] = [kVK_Space: "Space", kVK_Return: "Return", kVK_Escape: "Escape",
                                    kVK_Tab: "Tab", kVK_Delete: "Delete"]
        if let n = named[Int(code)] { return n }
        guard let layoutData = currentLayoutData() else { return nil }
        var result: String?
        layoutData.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
            var dead: UInt32 = 0
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0,
                                        UInt32(LMGetKbdType()), UInt32(kUCKeyTranslateNoDeadKeysBit),
                                        &dead, chars.count, &length, &chars)
            if status == noErr, length >= 1 {
                result = String(utf16CodeUnits: chars, count: length)
            }
        }
        return result
    }

    static func vKeyCode() -> CGKeyCode { keyCode(for: "v") ?? CGKeyCode(kVK_ANSI_V) }

    /// Posts Cmd+<character> (key down, then up) to the session event tap. The
    /// modifiers the user may still be physically holding from the hotkey are
    /// filtered so they do not leak into the synthetic event.
    static func postCommand(_ character: Character, extra: CGEventFlags = []) {
        let fallback: [Character: Int] = ["v": kVK_ANSI_V, "c": kVK_ANSI_C, "z": kVK_ANSI_Z,
                                          "b": kVK_ANSI_B, "i": kVK_ANSI_I]
        let key = keyCode(for: character) ?? CGKeyCode(fallback[character] ?? kVK_ANSI_V)
        postKey(key, flags: CGEventFlags.maskCommand.union(extra))
    }

    static func postKey(_ key: CGKeyCode, flags: CGEventFlags) {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        source.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalMouseEvents, .permitSystemDefinedEvents],
            state: .eventSuppressionStateSuppressionInterval)
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cgAnnotatedSessionEventTap)
        usleep(8_000)
        up?.post(tap: .cgAnnotatedSessionEventTap)
    }

    private static func currentLayoutData() -> Data? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        return Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    }
}
