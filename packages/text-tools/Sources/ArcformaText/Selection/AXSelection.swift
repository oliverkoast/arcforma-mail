import AppKit
import ApplicationServices

enum AXReadResult: Equatable {
    /// A non-empty selection.
    case text(String)
    /// The focused element reports an empty selection.
    case empty
    /// The host exposes no AXSelectedText at all (Chromium family while the
    /// accessibility tree is dormant).
    case noValue
    /// The focused element is a secure text field; never read or replace.
    case secure
    /// No focused element could be found, or the read failed.
    case unavailable(Int32)
}

/// In-process AX reads of the frontmost app's focused element. No osascript,
/// no helper binary: the cost of a read is a few IPC round trips.
enum AXSelection {

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Every AX read runs on the main thread, and the system default lets a
    /// hung host block a read for 6 s. This caps each round trip.
    static let messagingTimeout: Float = 0.5

    /// Triggers the system prompt and creates the row in System Settings.
    @discardableResult
    static func requestTrust() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /// The focused element of `pid`, with a short retry ladder: an app that just
    /// became frontmost can take a beat to answer (from openwhispr's
    /// macos-text-monitor.swift, with a tighter schedule for a hotkey path).
    static func focusedElement(pid: pid_t, attempts: Int = 3, delay: TimeInterval = 0.06) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        for attempt in 1...max(1, attempts) {
            var value: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value)
            if err == .success, let value {
                let element = value as! AXUIElement
                AXUIElementSetMessagingTimeout(element, messagingTimeout)
                return element
            }
            if attempt < attempts { Thread.sleep(forTimeInterval: delay) }
        }
        return nil
    }

    static func role(of element: AXUIElement) -> String? {
        attribute(element, kAXRoleAttribute) as? String
    }

    static func subrole(of element: AXUIElement) -> String? {
        attribute(element, kAXSubroleAttribute) as? String
    }

    static func isSecure(_ element: AXUIElement) -> Bool {
        if subrole(of: element) == kAXSecureTextFieldSubrole { return true }
        if role(of: element) == "AXSecureTextField" { return true }
        return false
    }

    /// AXSelectedText of the focused element of `pid`. `attempts` is the
    /// focused-element retry ladder; the 250 ms toolbar poll passes 1 so it
    /// never sleeps on the main thread.
    static func read(pid: pid_t, attempts: Int = 3) -> AXReadResult {
        guard let element = focusedElement(pid: pid, attempts: attempts) else { return .unavailable(-1) }
        return read(element: element)
    }

    static func read(element: AXUIElement) -> AXReadResult {
        if isSecure(element) { return .secure }
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &value)
        switch err {
        case .success:
            guard let text = value as? String else { return .noValue }
            return text.isEmpty ? .empty : .text(text)
        case .noValue, .attributeUnsupported:
            return .noValue
        default:
            return .unavailable(err.rawValue)
        }
    }

    /// Screen bounds of the current selection in Cocoa coordinates (origin
    /// bottom-left), or nil when the host does not answer AXBoundsForRange.
    static func selectionBounds(element: AXUIElement) -> CGRect? {
        var rangeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeValue) == .success,
              let rangeValue else { return nil }
        let axRange = rangeValue as! AXValue
        var range = CFRange()
        guard AXValueGetValue(axRange, .cfRange, &range) else { return nil }
        var boundsValue: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString,
                                                         axRange, &boundsValue) == .success,
              let boundsValue else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(boundsValue as! AXValue, .cgRect, &rect) else { return nil }
        guard rect.width.isFinite, rect.height.isFinite, rect.width >= 0, rect.height >= 0 else { return nil }
        return flipToCocoa(rect)
    }

    /// AX reports top-left-origin coordinates on the primary display; AppKit
    /// wants bottom-left.
    static func flipToCocoa(_ rect: CGRect) -> CGRect {
        guard let primary = NSScreen.screens.first else { return rect }
        let height = primary.frame.height
        return CGRect(x: rect.origin.x, y: height - rect.origin.y - rect.height,
                      width: rect.width, height: rect.height)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
