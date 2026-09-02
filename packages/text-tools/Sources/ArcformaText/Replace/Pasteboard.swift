import AppKit

/// Everything that was on the general pasteboard, every flavor of every item.
struct PasteboardSnapshot {
    var items: [[NSPasteboard.PasteboardType: Data]]
    var changeCount: Int
    var isEmpty: Bool { items.isEmpty }
}

/// Save and restore all flavors; write our replacement marked
/// `org.nspasteboard.TransientType` so clipboard managers ignore it.
enum Pasteboard {
    static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    static var changeCount: Int { NSPasteboard.general.changeCount }

    static func snapshot() -> PasteboardSnapshot {
        let pb = NSPasteboard.general
        var items: [[NSPasteboard.PasteboardType: Data]] = []
        for item in pb.pasteboardItems ?? [] {
            var flavors: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                // Promised flavors return nil and cannot be replayed; skip them.
                if let data = item.data(forType: type) { flavors[type] = data }
            }
            if !flavors.isEmpty { items.append(flavors) }
        }
        return PasteboardSnapshot(items: items, changeCount: pb.changeCount)
    }

    @discardableResult
    static func restore(_ snapshot: PasteboardSnapshot) -> Int {
        let pb = NSPasteboard.general
        pb.clearContents()
        guard !snapshot.isEmpty else { return pb.changeCount }
        let items: [NSPasteboardItem] = snapshot.items.map { flavors in
            let item = NSPasteboardItem()
            for (type, data) in flavors { item.setData(data, forType: type) }
            return item
        }
        pb.writeObjects(items)
        return pb.changeCount
    }

    /// Restores `snapshot` only when the pasteboard still carries the change
    /// count from our own write. A user copy in the window wins and is left
    /// alone. Returns whether the restore happened.
    @discardableResult
    static func restoreIfOurs(_ snapshot: PasteboardSnapshot, ours: Int) -> Bool {
        guard changeCount == ours else { return false }
        restore(snapshot)
        return true
    }

    /// Writes plain text (and an optional public.html flavor) as one transient
    /// item. Returns the resulting changeCount so the caller can tell later
    /// whether the pasteboard is still ours.
    @discardableResult
    static func write(plain: String, html: String? = nil, transient: Bool = true) -> Int {
        let pb = NSPasteboard.general
        pb.clearContents()
        let item = NSPasteboardItem()
        item.setString(plain, forType: .string)
        if let html { item.setString(html, forType: .html) }
        if transient { item.setData(Data(), forType: transientType) }
        pb.writeObjects([item])
        return pb.changeCount
    }

    /// Current plain-text content, if any.
    static func currentString() -> String? {
        NSPasteboard.general.string(forType: .string)
    }
}
