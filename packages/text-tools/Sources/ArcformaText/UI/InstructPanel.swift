import AppKit

/// Non-activating key panel: mono eyebrow, Inter text field, one ink pill
/// button "Replace", the wordmark in the footer. Return sends, Escape cancels.
/// The host app stays frontmost while the field has key focus.
final class InstructPanel: NSObject, NSTextFieldDelegate {
    static let shared = InstructPanel()

    var onSubmit: ((String) -> Void)?
    var onCancel: (() -> Void)?

    private let panel: CardPanel
    private let field: NSTextField
    private let button: PillButton

    private override init() {
        panel = CardPanel(size: NSSize(width: 440, height: 132), keyable: true)
        field = NSTextField(frame: .zero)
        button = PillButton(title: "Replace")
        super.init()

        let card = panel.card
        let eyebrow = NSTextField(labelWithAttributedString: Brand.eyebrow("Edit with instruction"))
        eyebrow.translatesAutoresizingMaskIntoConstraints = false

        field.translatesAutoresizingMaskIntoConstraints = false
        field.placeholderString = "What should change"
        field.font = Brand.font(.inter, size: 14, weight: 400)
        field.textColor = Brand.ink
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.lineBreakMode = .byTruncatingTail
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.delegate = self
        if let cell = field.cell as? NSTextFieldCell {
            cell.placeholderAttributedString = NSAttributedString(
                string: "What should change",
                attributes: [.font: Brand.font(.inter, size: 14), .foregroundColor: Brand.inkSoft])
        }

        // Hairline under the field: interior structure, so --af-rule is allowed.
        let underline = NSBox()
        underline.boxType = .custom
        underline.borderWidth = 0
        underline.fillColor = Brand.rule
        underline.translatesAutoresizingMaskIntoConstraints = false

        button.translatesAutoresizingMaskIntoConstraints = false
        button.onClick = { [weak self] in self?.submit() }

        let wordmark = NSImageView()
        wordmark.image = Brand.wordmark(width: Brand.wordmarkMinWidth)
        wordmark.imageScaling = .scaleProportionallyDown
        wordmark.translatesAutoresizingMaskIntoConstraints = false

        [eyebrow, field, underline, button, wordmark].forEach(card.addSubview)
        NSLayoutConstraint.activate([
            eyebrow.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            eyebrow.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),

            field.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            field.trailingAnchor.constraint(equalTo: button.leadingAnchor, constant: -12),
            field.topAnchor.constraint(equalTo: eyebrow.bottomAnchor, constant: 12),
            field.heightAnchor.constraint(equalToConstant: 22),

            underline.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            underline.trailingAnchor.constraint(equalTo: field.trailingAnchor),
            underline.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 4),
            underline.heightAnchor.constraint(equalToConstant: 1),

            button.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            button.centerYAnchor.constraint(equalTo: field.centerYAnchor),
            button.heightAnchor.constraint(equalToConstant: 30),

            wordmark.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            wordmark.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
            wordmark.widthAnchor.constraint(equalToConstant: Brand.wordmarkMinWidth),
            wordmark.heightAnchor.constraint(equalToConstant: Brand.wordmarkMinWidth * 48.3 / 291.64),
        ])
    }

    var isVisible: Bool { panel.isVisible }

    func present(above rect: CGRect?) {
        field.stringValue = ""
        panel.place(above: rect, gap: 10)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    func dismiss() {
        panel.orderOut(nil)
    }

    private func submit() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        dismiss()
        onSubmit?(text)
    }

    private func cancel() {
        dismiss()
        onCancel?()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            submit(); return true
        case #selector(NSResponder.cancelOperation(_:)):
            cancel(); return true
        default:
            return false
        }
    }
}

/// The one button shape: 999 pt radius, Archivo 500, ink ground, white label.
/// Hover goes to ink-2 (the site uses the stipple sweep; a menu-bar panel keeps
/// the quiet form).
final class PillButton: NSView {
    var onClick: (() -> Void)?
    private let label: NSTextField
    private var hovered = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }

    init(title: String) {
        label = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        label.font = Brand.font(.button, size: 13, weight: 500)
        label.textColor = Brand.white
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(equalTo: label.widthAnchor, constant: 32),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
    }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds, xRadius: Brand.pillRadius, yRadius: Brand.pillRadius)
        (pressed || hovered ? Brand.ink2 : Brand.ink).setFill()
        path.fill()
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
