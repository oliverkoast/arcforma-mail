import AppKit

/// The selection toolbar: a horizontal card, 14 pt radius, 1 pt rule edge,
/// mono eyebrow "TEXT TOOLS", Inter 13 buttons, hover mist, active cobalt.
/// Never becomes key, so a click does not move focus away from the host.
///
/// F-MAIL-04: the card is narrower than the 120 pt wordmark minimum, so it
/// carries the mono eyebrow instead of the wordmark, pending F-02.
final class ToolbarPanel {
    static let shared = ToolbarPanel()

    var onSelect: ((TextAction) -> Void)?

    private let panel: CardPanel
    private let stack: NSStackView
    private let eyebrow: NSTextField

    private init() {
        panel = CardPanel(size: NSSize(width: 400, height: 40), keyable: false)
        stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 5, left: 8, bottom: 5, right: 8)
        stack.translatesAutoresizingMaskIntoConstraints = false
        eyebrow = NSTextField(labelWithAttributedString: Brand.eyebrow("Text tools"))
        panel.card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: panel.card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: panel.card.trailingAnchor),
            stack.topAnchor.constraint(equalTo: panel.card.topAnchor),
            stack.bottomAnchor.constraint(equalTo: panel.card.bottomAnchor),
        ])
    }

    var isVisible: Bool { panel.isVisible }

    /// True when `point` (screen coordinates) is inside the toolbar.
    func contains(_ point: CGPoint) -> Bool { panel.isVisible && panel.frame.contains(point) }

    func present(actions: [TextAction], above rect: CGRect?) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.addArrangedSubview(eyebrow)
        stack.setCustomSpacing(10, after: eyebrow)
        for action in actions {
            let button = ToolButton(title: action.title)
            button.onClick = { [weak self] in self?.onSelect?(action) }
            stack.addArrangedSubview(button)
        }
        stack.layoutSubtreeIfNeeded()
        let size = stack.fittingSize
        panel.setContentSize(NSSize(width: ceil(size.width), height: 40))
        panel.place(above: rect, gap: 8)
        panel.orderFrontRegardless()
    }

    func dismiss() { panel.orderOut(nil) }
}

/// Inter 13 label; hover mist, active cobalt with a white label.
final class ToolButton: NSView {
    var onClick: (() -> Void)?
    private let label: NSTextField
    private var hovered = false { didSet { refresh() } }
    private var pressed = false { didSet { refresh() } }

    init(title: String) {
        label = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        label.font = Brand.font(.inter, size: 13, weight: 500)
        label.textColor = Brand.ink
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(equalTo: label.widthAnchor, constant: 20),
            heightAnchor.constraint(equalToConstant: 30),
        ])
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func refresh() {
        let active = pressed
        layer?.backgroundColor = active ? Brand.cobalt.cgColor : hovered ? Brand.mist.cgColor : NSColor.clear.cgColor
        label.textColor = active ? Brand.white : Brand.ink
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func mouseDown(with event: NSEvent) { pressed = true }
    override func mouseUp(with event: NSEvent) {
        pressed = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
    }
}
