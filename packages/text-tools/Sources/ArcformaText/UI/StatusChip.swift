import AppKit

/// A small pill near the selection: "Fixing", "Done", "No changes",
/// "Select text first", "Sign in to Claude Code". Never takes key, ignores the
/// mouse.
final class StatusChip {
    static let shared = StatusChip()

    private let panel: CardPanel
    private let label: NSTextField
    private var hideWork: DispatchWorkItem?

    private init() {
        panel = CardPanel(size: NSSize(width: 120, height: 28), keyable: false)
        panel.ignoresMouseEvents = true
        panel.card.cornerRadius = Brand.pillRadius
        label = NSTextField(labelWithString: "")
        label.font = Brand.font(.inter, size: 12, weight: 500)
        label.textColor = Brand.ink
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        panel.card.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: panel.card.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: panel.card.centerYAnchor),
        ])
    }

    /// Shows `text` near `rect` (or the mouse). `duration` nil keeps it up
    /// until the next call or `hide()`.
    func show(_ text: String, near rect: CGRect?, for duration: TimeInterval? = nil) {
        hideWork?.cancel()
        label.stringValue = text
        let width = ceil(label.intrinsicContentSize.width) + 28
        panel.setContentSize(NSSize(width: max(72, width), height: 28))
        panel.place(above: rect, gap: 6)
        panel.orderFrontRegardless()
        // The caller may block the main thread briefly right after this (the
        // AX capture ladder), so paint now rather than on the next run loop pass.
        panel.displayIfNeeded()
        if let duration {
            let work = DispatchWorkItem { [weak self] in self?.hide() }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
        }
    }

    /// Repositions the current chip once the selection bounds are known.
    func move(near rect: CGRect?) {
        guard panel.isVisible, let rect else { return }
        panel.place(above: rect, gap: 6)
    }

    func hide() {
        hideWork?.cancel()
        panel.orderOut(nil)
    }
}
