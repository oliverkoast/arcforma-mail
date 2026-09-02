import AppKit
import Carbon.HIToolbox

/// A process-wide hotkey via Carbon's `RegisterEventHotKey`, ported from
/// clipstack. This remains the only way to get a global hotkey without an event
/// tap (which would demand Input Monitoring on top of Accessibility).
final class HotKey {

    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private static var handlers: [UInt32: () -> Void] = [:]
    private static var nextID: UInt32 = 1
    private let id: UInt32

    init() {
        id = HotKey.nextID
        HotKey.nextID += 1
    }

    deinit { unregister() }

    var isRegistered: Bool { ref != nil }

    @discardableResult
    func register(_ chord: Chord, action: @escaping () -> Void) -> Bool {
        register(keyCode: chord.keyCode, modifiers: chord.modifiers, action: action)
    }

    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) -> Bool {
        unregister()
        HotKey.handlers[id] = action

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hkID = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                           EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            guard status == noErr else { return status }
            if let action = HotKey.handlers[hkID.id] {
                DispatchQueue.main.async(execute: action)
            }
            return noErr
        }, 1, &spec, nil, &handler)

        let hkID = EventHotKeyID(signature: OSType(0x41_52_43_54), id: id) // 'ARCT'
        let status = RegisterEventHotKey(keyCode, modifiers, hkID,
                                         GetApplicationEventTarget(), 0, &ref)
        if status != noErr {
            // Leave nothing behind on failure: the handler installed above
            // would otherwise outlive the chord it was meant for.
            unregister()
            return false
        }
        return true
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        if let handler { RemoveEventHandler(handler) }
        handler = nil
        HotKey.handlers[id] = nil
    }
}

/// One chord: a virtual key code plus a Carbon modifier mask.
struct Chord: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32

    /// Plain-text label for logs and the README ("Cmd+Shift+J").
    var label: String {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 { parts.append("Ctrl") }
        if modifiers & UInt32(optionKey) != 0 { parts.append("Option") }
        if modifiers & UInt32(shiftKey) != 0 { parts.append("Shift") }
        if modifiers & UInt32(cmdKey) != 0 { parts.append("Cmd") }
        // Single characters read as "J"; named keys keep their name ("Escape").
        let key = KeySynth.character(for: CGKeyCode(keyCode)) ?? "key \(keyCode)"
        parts.append(key.count == 1 ? key.uppercased() : key)
        return parts.joined(separator: "+")
    }

    /// Menu item key equivalent, for display in the status menu. The Carbon
    /// hotkey does the real work; the menu equivalent only shows the chord.
    var menuKeyEquivalent: (String, NSEvent.ModifierFlags) {
        var flags: NSEvent.ModifierFlags = []
        if modifiers & UInt32(controlKey) != 0 { flags.insert(.control) }
        if modifiers & UInt32(optionKey) != 0 { flags.insert(.option) }
        if modifiers & UInt32(shiftKey) != 0 { flags.insert(.shift) }
        if modifiers & UInt32(cmdKey) != 0 { flags.insert(.command) }
        return (KeySynth.character(for: CGKeyCode(keyCode))?.lowercased() ?? "", flags)
    }
}

/// The three chords, overridable via
/// `defaults write ai.arcforma.text <name>KeyCode -int <code>` and
/// `defaults write ai.arcforma.text <name>Modifiers -int <carbon mask>`
/// with names fix, instruct, restore. Read once at launch.
///
/// Cmd+J is a knowing decision (it pre-empts Chrome Downloads, Slack Jump to,
/// Xcode and Pages Jump to Selection, and the VS Code panel toggle).
enum Chords {
    static var fix: Chord { read("fix", fallback: Chord(keyCode: jKeyCode, modifiers: UInt32(cmdKey))) }
    static var instruct: Chord { read("instruct", fallback: Chord(keyCode: jKeyCode, modifiers: UInt32(cmdKey | shiftKey))) }
    static var restore: Chord { read("restore", fallback: Chord(keyCode: jKeyCode, modifiers: UInt32(cmdKey | optionKey))) }
    static let escape = Chord(keyCode: UInt32(kVK_Escape), modifiers: 0)

    /// The physical key that types "j" moves with the keyboard layout, so the
    /// default is resolved through the layout, the same way Cmd+V is.
    private static var jKeyCode: UInt32 {
        UInt32(KeySynth.keyCode(for: "j") ?? CGKeyCode(kVK_ANSI_J))
    }

    private static func read(_ name: String, fallback: Chord) -> Chord {
        let d = UserDefaults.standard
        guard d.object(forKey: "\(name)KeyCode") != nil else { return fallback }
        let code = UInt32(clamping: d.integer(forKey: "\(name)KeyCode"))
        let mods = d.object(forKey: "\(name)Modifiers") != nil
            ? UInt32(clamping: d.integer(forKey: "\(name)Modifiers"))
            : fallback.modifiers
        return Chord(keyCode: code, modifiers: mods)
    }
}
