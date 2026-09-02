import AppKit

/// Everything an action needs to run against one captured session.
struct ActionContext {
    var session: Session
    var instruction: String?
    var replacer: Replacer = .shared
    var ai: AIService = .shared
    /// Chip updates while the action runs ("Fixing", "Editing").
    var status: (String) -> Void = { _ in }
    /// Lets the coordinator cancel an in-flight model call on Escape.
    var register: (AIRequestHandle) -> Void = { _ in }
    /// Milliseconds from the hotkey to the captured session, for the timing line.
    var captureMs: Int = 0
}

/// Per-request latency, logged at INFO so the real-app matrix can be
/// measured: `timing text.fix: capture 12 ms, model 1830 ms, replace 410 ms`.
struct Timings {
    var task: String
    var captureMs: Int
    var modelMs: Int
    var replaceMs: Int
    var model: String
    var host: String
    var route: CaptureRoute
    var outcome: String

    var totalMs: Int { captureMs + modelMs + replaceMs }

    var line: String {
        "timing \(task): capture \(captureMs) ms, model \(modelMs) ms, replace \(replaceMs) ms, total \(totalMs) ms, "
            + "outcome \(outcome), model \(model.isEmpty ? "none" : model), host \(host), route \(route)"
    }
}

enum ActionOutcome: Equatable {
    case replaced
    case unchanged
    /// The host did the work itself (native Cmd+B, Cmd+Z). No chip.
    case delegated
    case restored(String)
}

enum ActionFailure: Error, Equatable {
    case replace(ReplaceError)
    case ai(AIError)
    case nothingToRestore

    var chipText: String {
        switch self {
        case .replace(let e): return e.chipText
        case .ai(let e): return e.chipText
        case .nothingToRestore: return "Nothing to restore"
        }
    }
}

protocol TextAction {
    var id: String { get }
    /// Button label. Says what happens.
    var title: String { get }
    func isAvailable(_ profile: HostProfile) -> Bool
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void)
}

enum Actions {
    static let fix = FixAction()
    static let instruct = InstructAction()
    static let bold = BoldAction()
    static let italic = ItalicAction()
    static let bullets = BulletsAction()
    static let numbered = NumberedAction()
    static let undo = UndoAction()

    /// Toolbar order.
    static let toolbar: [TextAction] = [fix, instruct, bold, italic, bullets, numbered]
}

// MARK: - Model-backed actions

private func runModel(_ ctx: ActionContext, system: String, task: String,
                      completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
    let user = Prompts.envelope(instruction: ctx.instruction, selectedText: ctx.session.original)
    let started = Date()
    var finished = false
    func timings(modelMs: Int, replaceMs: Int, model: String, outcome: String) -> Timings {
        Timings(task: task, captureMs: ctx.captureMs, modelMs: modelMs, replaceMs: replaceMs, model: model,
                host: ctx.session.host.bundleId, route: ctx.session.route, outcome: outcome)
    }
    let handle = ctx.ai.complete(system: system, user: user, task: task) { result in
        finished = true
        let modelMs = Int(Date().timeIntervalSince(started) * 1000)
        switch result {
        case .failure(let error):
            Log.error("\(task): \(error)")
            Log.write(timings(modelMs: modelMs, replaceMs: 0, model: "", outcome: "ai \(error.chipText)").line)
            completion(.failure(.ai(error)))
        case .success(let done):
            switch Prompts.extract(done.text, original: ctx.session.original) {
            case .failure(.missingMarker):
                Log.error("\(task): output missing completion marker (\(done.model), \(modelMs) ms)")
                Log.write(timings(modelMs: modelMs, replaceMs: 0, model: done.model, outcome: "truncated").line)
                completion(.failure(.ai(.truncated)))
            case .failure(.empty):
                Log.error("\(task): empty output (\(done.model), \(modelMs) ms)")
                Log.write(timings(modelMs: modelMs, replaceMs: 0, model: done.model, outcome: "empty").line)
                completion(.failure(.ai(.empty)))
            case .success(let text):
                Log.write("\(task): \(done.model) in \(modelMs) ms, \(ctx.session.original.count) -> \(text.count) chars")
                if text == ctx.session.original {
                    // Never paste an identical result: the host would register
                    // an edit and Cmd+Z would have to undo nothing.
                    Log.write(timings(modelMs: modelMs, replaceMs: 0, model: done.model, outcome: "unchanged").line)
                    completion(.success(.unchanged)); return
                }
                let replaceStarted = Date()
                ctx.replacer.replace(ctx.session, plain: text) { r in
                    let replaceMs = Int(Date().timeIntervalSince(replaceStarted) * 1000)
                    switch r {
                    case .success:
                        Log.write(timings(modelMs: modelMs, replaceMs: replaceMs, model: done.model, outcome: "replaced").line)
                        completion(.success(.replaced))
                    case .failure(let e):
                        Log.write(timings(modelMs: modelMs, replaceMs: replaceMs, model: done.model, outcome: "refused \(e.chipText)").line)
                        completion(.failure(.replace(e)))
                    }
                }
            }
        }
    }
    // A backend that fails synchronously (no config, no binary) has already
    // completed; registering its handle now would arm Escape with nothing to
    // release it. The coordinator guards this too; this keeps it local.
    if !finished { ctx.register(handle) }
}

struct FixAction: TextAction {
    let id = "fix"
    let title = "Fix"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        ctx.status("Fixing")
        runModel(ctx, system: Prompts.fixSystem, task: "text.fix", completion: completion)
    }
}

struct InstructAction: TextAction {
    let id = "instruct"
    let title = "Edit"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        guard let instruction = ctx.instruction, !instruction.trimmingCharacters(in: .whitespaces).isEmpty else {
            completion(.failure(.ai(.empty))); return
        }
        ctx.status("Editing")
        runModel(ctx, system: Prompts.instructSystem, task: "text.instruct", completion: completion)
    }
}

// MARK: - Formatting

/// Pure text transforms for plain hosts and the HTML flavor for rich ones.
enum Markdown {
    /// Wraps the trimmed core, keeping leading and trailing whitespace outside
    /// the markers so `**text **` never happens.
    static func wrap(_ text: String, with marker: String) -> String {
        let leading = text.prefix { $0.isWhitespace }
        let trailing = text.reversed().prefix { $0.isWhitespace }
        let core = text.dropFirst(leading.count).dropLast(trailing.count)
        guard !core.isEmpty else { return text }
        return leading + marker + core + marker + String(trailing.reversed())
    }

    static func bold(_ text: String) -> String { wrap(text, with: "**") }
    static func italic(_ text: String) -> String { wrap(text, with: "*") }

    /// Splits into lines and strips an existing list prefix from each.
    static func items(_ text: String) -> [String] {
        text.components(separatedBy: "\n").map { line in
            var t = line.trimmingCharacters(in: .whitespaces)
            if let r = t.range(of: #"^([-*+]|\d+[.)])\s+"#, options: .regularExpression) {
                t.removeSubrange(r)
            }
            return t
        }
    }

    static func bullets(_ text: String) -> String {
        items(text).map { $0.isEmpty ? "" : "- \($0)" }.joined(separator: "\n")
    }

    static func numbered(_ text: String) -> String {
        var n = 0
        return items(text).map { item -> String in
            if item.isEmpty { return "" }
            n += 1
            return "\(n). \(item)"
        }.joined(separator: "\n")
    }

    static func htmlList(_ text: String, ordered: Bool) -> String {
        let tag = ordered ? "ol" : "ul"
        let lis = items(text).filter { !$0.isEmpty }.map { "<li>\(escape($0))</li>" }.joined()
        return "<\(tag)>\(lis)</\(tag)>"
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

/// Rich host: post the native chord and let the host own toggle and undo.
/// Plain host: replace with markdown.
private func toggleStyle(_ ctx: ActionContext, chord: Character, markdown: (String) -> String,
                         completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
    if ctx.session.profile.rich {
        Replacer.ensureFrontmost(ctx.session.host) { ok in
            guard ok else { completion(.failure(.replace(.hostChanged))); return }
            KeySynth.postCommand(chord)
            completion(.success(.delegated))
        }
        return
    }
    let wrapped = markdown(ctx.session.original)
    guard wrapped != ctx.session.original else { completion(.success(.unchanged)); return }
    ctx.replacer.replace(ctx.session, plain: wrapped) { r in
        completion(r.map { .replaced }.mapError { .replace($0) })
    }
}

struct BoldAction: TextAction {
    let id = "bold"
    let title = "Bold"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        toggleStyle(ctx, chord: "b", markdown: Markdown.bold, completion: completion)
    }
}

struct ItalicAction: TextAction {
    let id = "italic"
    let title = "Italic"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        toggleStyle(ctx, chord: "i", markdown: Markdown.italic, completion: completion)
    }
}

/// Rich host: paste public.html plus the plain-text fallback flavor. Plain
/// host: line prefixes.
private func makeList(_ ctx: ActionContext, ordered: Bool,
                      completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
    let plain = ordered ? Markdown.numbered(ctx.session.original) : Markdown.bullets(ctx.session.original)
    let html = ctx.session.profile.rich ? Markdown.htmlList(ctx.session.original, ordered: ordered) : nil
    guard plain != ctx.session.original || html != nil else { completion(.success(.unchanged)); return }
    ctx.replacer.replace(ctx.session, plain: plain, html: html) { r in
        completion(r.map { .replaced }.mapError { .replace($0) })
    }
}

struct BulletsAction: TextAction {
    let id = "bullets"
    let title = "Bullets"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        makeList(ctx, ordered: false, completion: completion)
    }
}

struct NumberedAction: TextAction {
    let id = "numbered"
    let title = "Numbered"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        makeList(ctx, ordered: true, completion: completion)
    }
}

/// Cmd+Option+J. Not a toolbar button; performs against whatever is selected
/// now, so the context's session is ignored.
struct UndoAction: TextAction {
    let id = "undo"
    let title = "Restore"
    func isAvailable(_ profile: HostProfile) -> Bool { !profile.refused }
    func perform(_ ctx: ActionContext, completion: @escaping (Result<ActionOutcome, ActionFailure>) -> Void) {
        guard let last = ctx.replacer.last, last.isFresh else { completion(.failure(.nothingToRestore)); return }
        ctx.replacer.restoreLast { r in
            completion(r.map { .restored($0) }.mapError { .replace($0) })
        }
    }
}
