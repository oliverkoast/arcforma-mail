import AppKit

/// `ArcformaText --selftest`: prints environment state, then runs the pure
/// logic checks that XCTest would otherwise carry (Command Line Tools ship no
/// XCTest, so `swift test` cannot run here).
///
/// Nothing here needs Accessibility or a Claude login. Anything that would
/// (a real AX read, a real paste, a real model call) is exercised only up to
/// the point where it must fail closed, and the test asserts that it did.
enum SelfTest {
    private static var failures = 0
    private static var passes = 0
    private static var tempDir: URL!

    static func run() -> Int32 {
        print("Arcforma Text self-test")
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("arcforma-text-selftest-\(getpid())")
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        // Keep test noise out of the live log unless the caller redirected it.
        if ProcessInfo.processInfo.environment["ARCFORMA_TEXT_LOG"] == nil {
            Log.fileURL = tempDir.appendingPathComponent("selftest.log")
        }

        print("accessibility trusted: \(AXSelection.isTrusted)")
        print("keycode for V: \(KeySynth.vKeyCode()) (layout-resolved), J: \(KeySynth.keyCode(for: "j").map(String.init) ?? "nil")")
        print("chords: fix \(Chords.fix.label), instruct \(Chords.instruct.label), restore \(Chords.restore.label)")
        print("resources: \(Resources.directory?.path ?? "not found")")
        print("log file: \(Log.fileURL.path)")

        // Daemon health, 1.5 s budget.
        let client = AIClient()
        print("daemon config: \(client.isConfigured ? DaemonConfig.url.path : "absent (\(DaemonConfig.url.path))")")
        var healthDone = false
        client.health { result in
            switch result {
            case .success(let h):
                print("daemon health: ok=\(h.ok) loggedIn=\(h.loggedIn.map(String.init) ?? "?") model=\(h.model ?? "?") local=\(h.local ?? "?") inFlight=\(h.inFlight ?? 0)")
            case .failure(let e):
                print("daemon health: \(e)")
            }
            healthDone = true
        }
        wait(until: { healthDone }, timeout: 3)
        let cli = ClaudeCLI()
        print("claude binary: \(cli.binary) installed=\(cli.isInstalled)")
        print("ai backend: \(AIService.shared.forceDirect ? "direct (forced)" : "daemon first")")

        brand()

        print("")
        markdown()
        hostPolicy()
        prompts()
        cliParsing()
        cliChain()
        cliProcessHygiene()
        pasteboard()
        clipboardCapture()
        replacePath()
        daemonClient()
        daemonIntegration()
        escapeLifecycle()
        strings()
        constants()

        print(failures == 0 ? "\n\(passes) checks passed, all self-tests passed."
                            : "\n\(passes) checks passed, \(failures) self-test(s) FAILED.")
        return failures == 0 ? 0 : 1
    }

    private static func check(_ name: String, _ condition: Bool, _ detail: @autoclosure () -> String = "") {
        if condition {
            passes += 1
            print("ok    \(name)")
        } else {
            failures += 1
            print("FAIL  \(name) \(detail())")
        }
    }

    private static func skip(_ name: String, _ reason: String) {
        print("skip  \(name): \(reason)")
    }

    /// Spins the main run loop so completions dispatched to main can land.
    private static func wait(until done: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    private static func writeScript(_ name: String, _ body: String) -> String {
        let url = tempDir.appendingPathComponent(name)
        try? body.write(to: url, atomically: true, encoding: .utf8)
        chmod(url.path, 0o755)
        return url.path
    }

    /// A stub `claude` that answers every model with `text` plus the marker,
    /// touches `calledFile` when invoked, and reports stdin and env hygiene.
    private static func stubCLI(answer text: String, calledFile: String? = nil) -> String {
        let touch = calledFile.map { "touch '\($0)'" } ?? ":"
        return writeScript("claude-stub-\(UUID().uuidString.prefix(8)).sh", """
        #!/bin/bash
        \(touch)
        if [ "$1" = "--version" ]; then echo "stub 0.0.1"; exit 0; fi
        if read -t 1 _line; then stdin="stdin data"; elif [ $? -gt 128 ]; then stdin="stdin open"; else stdin="stdin eof"; fi
        others=$(env | grep -v -E '^(HOME|PATH|PWD|OLDPWD|SHLVL|_)=' | wc -l | tr -d ' ')
        printf '{"type":"result","is_error":false,"result":"%s<<ARCFORMA_END>>","stdin":"%s","otherEnv":%s}\\n' "\(text)" "$stdin" "$others"
        """)
    }

    /// `Result<Void, _>` is not Equatable; compare the failure only.
    private static func failed(_ r: Result<Void, ReplaceError>?, with error: ReplaceError) -> Bool {
        if case .failure(let e)? = r { return e == error }
        return false
    }

    private static func logContents() -> String {
        Log.flush()
        return (try? String(contentsOf: Log.fileURL, encoding: .utf8)) ?? ""
    }

    // MARK: Cases

    /// Fonts register through CTFontManager and the wordmark decodes from SVG
    /// data; both work headless.
    private static func brand() {
        Brand.registerFonts()
        let families = Set(NSFontManager.shared.availableFontFamilies)
        for family in [Brand.Family.inter, .mono, .button] {
            let font = Brand.font(family, size: 13, weight: 500)
            print("font \(family.rawValue): registered=\(families.contains(family.rawValue)) resolved=\(font.fontName)")
        }
        let mark = Brand.wordmark(width: 120)
        print("wordmark: \(mark.map { "\(Int($0.size.width))x\(Int($0.size.height)) pt" } ?? "not loaded")")
    }

    private static func markdown() {
        check("bold wraps", Markdown.bold("hello") == "**hello**")
        check("bold keeps outer whitespace", Markdown.bold(" hello ") == " **hello** ", Markdown.bold(" hello "))
        check("italic wraps", Markdown.italic("hi there") == "*hi there*")
        check("bullets prefix lines", Markdown.bullets("a\nb\nc") == "- a\n- b\n- c", Markdown.bullets("a\nb\nc"))
        check("bullets strip existing markers", Markdown.bullets("1. a\n* b") == "- a\n- b", Markdown.bullets("1. a\n* b"))
        check("bullets keep blank lines", Markdown.bullets("a\n\nb") == "- a\n\n- b", Markdown.bullets("a\n\nb"))
        check("numbered counts non-empty lines", Markdown.numbered("a\n\nb\nc") == "1. a\n\n2. b\n3. c", Markdown.numbered("a\n\nb\nc"))
        check("numbered strips existing markers", Markdown.numbered("- a\n- b") == "1. a\n2. b")
        check("html list escapes", Markdown.htmlList("a<b\nc", ordered: false) == "<ul><li>a&lt;b</li><li>c</li></ul>",
              Markdown.htmlList("a<b\nc", ordered: false))
        check("html ordered list", Markdown.htmlList("x\ny", ordered: true) == "<ol><li>x</li><li>y</li></ol>")
    }

    private static func hostPolicy() {
        for id in ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "io.alacritty",
                   "net.kovidgoyal.kitty", "dev.warp.Warp"] {
            check("terminal refused: \(id)", HostPolicy.isTerminal(id))
        }
        check("Notes is not a terminal", !HostPolicy.isTerminal("com.apple.Notes"))
        check("Chrome is chromium", HostPolicy.isChromium("com.google.Chrome"))
        check("Cursor is chromium", HostPolicy.isChromium("com.todesktop.230313mzl4w4u92"))
        check("Notes is not chromium", !HostPolicy.isChromium("com.apple.Notes"))
        check("VS Code is a line-copy editor", HostPolicy.isLineCopyEditor(bundleId: "com.microsoft.VSCode", name: "Code"))
        check("JetBrains by prefix", HostPolicy.isLineCopyEditor(bundleId: "com.jetbrains.intellij", name: "IntelliJ IDEA"))
        check("Sublime by signature", HostPolicy.isLineCopyEditor(bundleId: "com.sublimetext.4", name: "Sublime Text"))
        check("Notes is not a line-copy editor", !HostPolicy.isLineCopyEditor(bundleId: "com.apple.Notes", name: "Notes"))
        check("Notes text area is rich", HostPolicy.isRich(bundleId: "com.apple.Notes", axRole: kAXTextAreaRole))
        check("Notes text field is plain", !HostPolicy.isRich(bundleId: "com.apple.Notes", axRole: kAXTextFieldRole))
        check("VS Code is plain", !HostPolicy.isRich(bundleId: "com.microsoft.VSCode", axRole: kAXTextAreaRole))
        check("unknown host is plain", !HostPolicy.isRich(bundleId: "com.example.unknown", axRole: nil))
        check("Chrome is rich", HostPolicy.isRich(bundleId: "com.google.Chrome", axRole: nil))

        let term = HostPolicy.profile(for: Host(pid: 1, bundleId: "com.apple.Terminal", name: "Terminal"))
        check("terminal profile refused", term.refused)
        let own = HostPolicy.profile(for: Host(pid: ProcessInfo.processInfo.processIdentifier, bundleId: "ai.arcforma.text", name: "Arcforma Text"))
        check("own pid refused", own.refused)
        let pw = HostPolicy.profile(for: Host(pid: 4, bundleId: "com.1password.1password", name: "1Password"))
        check("password manager refused", pw.refused)
        let noValue = HostPolicy.profile(for: Host(pid: 2, bundleId: "com.example.electron", name: "Electron"), axReturnedNoValue: true)
        check("noValue host verifies lazily", noValue.lazyVerify && !noValue.refused)
        let slack = HostPolicy.profile(for: Host(pid: 3, bundleId: "com.tinyspeck.slackmacgap", name: "Slack"))
        check("Slack is lazy and rich", slack.lazyVerify && slack.rich)
        check("line copy shape: single line", ClipboardCapture.isSingleLineWithTerminator("one line\n"))
        check("line copy shape: crlf", ClipboardCapture.isSingleLineWithTerminator("one line\r\n"))
        check("line copy shape: two lines is a selection", !ClipboardCapture.isSingleLineWithTerminator("a\nb\n"))
        check("line copy shape: no terminator is a selection", !ClipboardCapture.isSingleLineWithTerminator("a"))
    }

    private static func prompts() {
        let m = Prompts.marker
        check("extract strips marker", Prompts.extract("Fixed text.\(m)") == .success("Fixed text."))
        check("extract rejects missing marker", Prompts.extract("Fixed text.") == .failure(.missingMarker))
        check("extract rejects empty", Prompts.extract("  \n\(m)") == .failure(.empty))
        check("extract rejects marker only", Prompts.extract(m) == .failure(.empty))
        check("extract trims newline before marker", Prompts.extract("Hello\n\(m)", original: "Hello") == .success("Hello"))
        check("extract trims newline before marker without original", Prompts.extract("Hello\n\(m)") == .success("Hello"))
        check("extract keeps trailing newline when original had one",
              Prompts.extract("Hello\n\(m)", original: "Hello\n") == .success("Hello\n"))
        check("extract normalises a doubled trailing newline to the original's",
              Prompts.extract("Hello\n\n\(m)", original: "Hello\n") == .success("Hello\n"))
        check("extract restores a trailing newline the model dropped",
              Prompts.extract("Hello\(m)", original: "Hello\n") == .success("Hello\n"))
        check("extract strips a leading newline the model added",
              Prompts.extract("\nHello\(m)", original: "Hello") == .success("Hello"))
        check("extract keeps leading whitespace the original had",
              Prompts.extract("x\(m)", original: "  x") == .success("  x"))
        check("extract keeps interior line breaks", Prompts.extract("a\n\nb\(m)", original: "a\n\nb") == .success("a\n\nb"))
        check("extract ignores trailing chatter", Prompts.extract("Hi\(m)\nAnything else?") == .success("Hi"))
        check("extract uses the last marker when the text contains one",
              Prompts.extract("see \(m) here\(m)", original: "see \(m) here") == .success("see \(m) here"))
        check("unchanged output compares equal to the original",
              Prompts.extract("Same text.\n\(m)", original: "Same text.") == .success("Same text."))

        let env = Prompts.envelope(instruction: "shorten", selectedText: "a \"quoted\" line")
        check("envelope is JSON with both fields",
              env == #"{"instruction":"shorten","selectedText":"a \"quoted\" line"}"#, env)
        let fixEnv = Prompts.envelope(instruction: nil, selectedText: "x")
        check("fix envelope omits instruction", fixEnv == #"{"selectedText":"x"}"#, fixEnv)
        let nasty = "line one\nline two\r\n\ttab \"quotes\" back\\slash \u{00E9}\u{1F600} \u{2014} </script> {\"k\":1}"
        let round = Prompts.envelope(instruction: "keep \"this\"\nline", selectedText: nasty)
        let parsed = (try? JSONSerialization.jsonObject(with: Data(round.utf8))) as? [String: String]
        check("envelope round-trips newlines, quotes, backslashes, unicode",
              parsed?["selectedText"] == nasty && parsed?["instruction"] == "keep \"this\"\nline", round)
        check("envelope escapes control characters", !round.contains("\n") && !round.contains("\t"), round)
        for prompt in [Prompts.fixSystem, Prompts.instructSystem] {
            check("prompt carries marker", prompt.contains(m))
            check("prompt has no em dash", !prompt.contains("\u{2014}") && !prompt.contains("\u{2013}"))
            check("prompt names Arcforma", prompt.contains("Arcforma AI"))
        }
    }

    private static func cliParsing() {
        let ok = Data(#"{"type":"result","is_error":false,"result":"Fixed.<<ARCFORMA_END>>","session_id":"x"}"#.utf8)
        check("cli parse result", ClaudeCLI.parse(ok) == .success("Fixed.<<ARCFORMA_END>>"))
        let err = Data(#"{"type":"result","is_error":true,"result":"API Error: 400 This model does not support this model"}"#.utf8)
        check("cli parse is_error", ClaudeCLI.parse(err) == .failure(.isError("API Error: 400 This model does not support this model")))
        check("cli parse invalid json", ClaudeCLI.parse(Data("nope".utf8)) == .failure(.invalidJSON))
        check("cli parse missing result", ClaudeCLI.parse(Data("{}".utf8)) == .failure(.missingResult))
        check("model fallback trigger", ClaudeCLI.isModelUnsupported("The selected model does not support this model"))
        check("model fallback not on other errors", !ClaudeCLI.isModelUnsupported("rate limited"))
        check("not-logged-in detection", ClaudeCLI.isNotLoggedIn("Not logged in. Please run /login"))
        check("model chain is fable, opus, sonnet", ClaudeCLI.models == ["claude-fable-5-1", "opus", "sonnet"])
        let inv = ClaudeCLI.invocation(user: "u", system: "s", model: "opus")
        check("cli args", inv.arguments == ["-p", "u", "--model", "opus", "--system-prompt", "s", "--output-format", "json",
                                            "--max-turns", "1", "--disallowedTools", "*", "--no-session-persistence"],
              inv.arguments.joined(separator: " "))
        check("cli env limited to HOME, PATH, and the optional headless token",
              Set(inv.environment.keys).isSubset(of: ["HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN"])
              && inv.environment["HOME"] != nil && inv.environment["PATH"] != nil)
        check("cli headless token only when a source exists",
              (inv.environment["CLAUDE_CODE_OAUTH_TOKEN"] != nil) == (ClaudeCLI.headlessToken() != nil))
    }

    /// Runs the model chain against a stub script: fable fails with
    /// "does not support this model", opus answers.
    private static func cliChain() {
        let stub = writeScript("claude-chain.sh", """
        #!/bin/sh
        if [ "$1" = "--version" ]; then echo "stub 0.0.1"; exit 0; fi
        model=""; prev=""
        for a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; done
        if [ "$model" = "claude-fable-5-1" ]; then
          echo '{"type":"result","is_error":true,"result":"API Error: 400 The selected model does not support this model"}'
          exit 1
        fi
        echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"Fixed by $model.<<ARCFORMA_END>>\\"}"
        """)

        let cli = ClaudeCLI()
        cli.binaryOverride = stub
        var outcome: Result<Completion, AIError>?
        var onMain = false
        cli.complete(system: "s", user: "u", timeout: 5) { onMain = Thread.isMainThread; outcome = $0 }
        wait(until: { outcome != nil }, timeout: 8)
        if case .success(let c)? = outcome {
            check("cli chain falls back to opus", c.model == "opus" && c.text == "Fixed by opus.<<ARCFORMA_END>>", "\(c)")
        } else {
            check("cli chain falls back to opus", false, "\(String(describing: outcome))")
        }
        check("cli completion lands on the main thread", onMain)

        // Timeout path: a stub that sleeps must be killed at the deadline.
        let slow = writeScript("claude-slow.sh", "#!/bin/sh\nsleep 5\n")
        cli.binaryOverride = slow
        var slowOutcome: Result<Completion, AIError>?
        var started = Date()
        cli.complete(system: "s", user: "u", timeout: 0.5) { slowOutcome = $0 }
        wait(until: { slowOutcome != nil }, timeout: 6)
        var elapsed = Date().timeIntervalSince(started)
        check("cli timeout terminates the process", slowOutcome == .failure(.timeout) && elapsed < 3,
              "\(String(describing: slowOutcome)) after \(elapsed) s")

        // A child that ignores SIGTERM is escalated to SIGKILL after the grace.
        let stubborn = writeScript("claude-stubborn.sh", "#!/bin/bash\ntrap '' TERM\nsleep 5\n")
        cli.binaryOverride = stubborn
        var stubbornOutcome: Result<Completion, AIError>?
        started = Date()
        cli.complete(system: "s", user: "u", timeout: 0.5) { stubbornOutcome = $0 }
        wait(until: { stubbornOutcome != nil }, timeout: 6)
        elapsed = Date().timeIntervalSince(started)
        check("cli timeout escalates to SIGKILL when SIGTERM is ignored",
              stubbornOutcome == .failure(.timeout) && elapsed < 0.5 + ClaudeCLI.killGrace + 1.5,
              "\(String(describing: stubbornOutcome)) after \(elapsed) s")

        // Escape: cancel mid-call ends the process and reports cancelled.
        cli.binaryOverride = slow
        var cancelledOutcome: Result<Completion, AIError>?
        started = Date()
        let handle = cli.complete(system: "s", user: "u", timeout: 5) { cancelledOutcome = $0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { handle.cancel() }
        wait(until: { cancelledOutcome != nil }, timeout: 6)
        elapsed = Date().timeIntervalSince(started)
        check("cli cancel terminates the process", cancelledOutcome == .failure(.cancelled) && elapsed < 3,
              "\(String(describing: cancelledOutcome)) after \(elapsed) s")

        var missing: Result<Completion, AIError>?
        cli.binaryOverride = tempDir.appendingPathComponent("nope").path
        cli.complete(system: "s", user: "u") { missing = $0 }
        wait(until: { missing != nil }, timeout: 2)
        if case .failure(.cliFailed)? = missing {
            check("cli missing binary reports cliFailed", true)
        } else {
            check("cli missing binary reports cliFailed", false, "\(String(describing: missing))")
        }
    }

    /// stdin is /dev/null, the environment is minimal, and a stderr flood
    /// cannot deadlock the pipe reads.
    private static func cliProcessHygiene() {
        let cli = ClaudeCLI()
        cli.binaryOverride = stubCLI(answer: "hygiene")
        var outcome: Result<Completion, AIError>?
        cli.complete(system: "s", user: "u", timeout: 5) { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 8)
        // The stub reports through extra JSON fields; parse them back.
        var stdinState = "", otherEnv = -1
        if case .success? = outcome {
            // Re-run the stub directly to read the diagnostic fields.
            let p = Process()
            p.executableURL = URL(fileURLWithPath: cli.binary)
            p.arguments = ["-p", "u"]
            p.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin"]
            p.standardInput = FileHandle.nullDevice
            let out = Pipe(); p.standardOutput = out
            try? p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                stdinState = json["stdin"] as? String ?? ""
                otherEnv = json["otherEnv"] as? Int ?? -1
            }
        }
        check("cli stub answers", outcome == .success(Completion(text: "hygiene<<ARCFORMA_END>>", model: "claude-fable-5-1",
                                                                    latencyMs: outcome.flatMap { try? $0.get().latencyMs } ?? -1)),
              "\(String(describing: outcome))")
        check("cli stdin is closed (/dev/null)", stdinState == "stdin eof", stdinState)
        check("cli environment carries nothing beyond HOME and PATH", otherEnv == 0, "\(otherEnv) extra vars")

        let flood = writeScript("claude-flood.sh", """
        #!/bin/sh
        head -c 300000 /dev/zero | tr '\\0' 'e' >&2
        echo '{"type":"result","is_error":false,"result":"after flood<<ARCFORMA_END>>"}'
        """)
        cli.binaryOverride = flood
        var floodOutcome: Result<Completion, AIError>?
        let started = Date()
        cli.complete(system: "s", user: "u", timeout: 5) { floodOutcome = $0 }
        wait(until: { floodOutcome != nil }, timeout: 8)
        if case .success(let c)? = floodOutcome {
            check("cli survives a 300 KB stderr flood", c.text == "after flood<<ARCFORMA_END>>", c.text)
        } else {
            check("cli survives a 300 KB stderr flood", false,
                  "\(String(describing: floodOutcome)) after \(Date().timeIntervalSince(started)) s")
        }
    }

    private static func pasteboard() {
        let saved = Pasteboard.snapshot()
        defer { Pasteboard.restore(saved) }
        let count = Pasteboard.write(plain: "arcforma selftest", html: "<b>x</b>")
        check("pasteboard write bumps changeCount", count == Pasteboard.changeCount)
        check("pasteboard write is readable", Pasteboard.currentString() == "arcforma selftest")
        let types = NSPasteboard.general.pasteboardItems?.first?.types ?? []
        check("pasteboard write is transient", types.contains(Pasteboard.transientType))
        check("pasteboard write carries html", types.contains(.html))
        Pasteboard.restore(saved)
        check("pasteboard restore round-trips", (Pasteboard.currentString() ?? "") == (saved.items.first?[.string].map { String(decoding: $0, as: UTF8.self) } ?? ""))

        // Replace-path restore: ours is restored, a user copy in the window wins.
        let before = Pasteboard.snapshot()
        let ours = Pasteboard.write(plain: "replacement", transient: true)
        check("restoreIfOurs restores when the changeCount is still ours", Pasteboard.restoreIfOurs(before, ours: ours))
        let ours2 = Pasteboard.write(plain: "replacement 2", transient: true)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("user copied this", forType: .string)
        let restored = Pasteboard.restoreIfOurs(before, ours: ours2)
        check("restoreIfOurs leaves a user copy alone", !restored && Pasteboard.currentString() == "user copied this",
              "restored=\(restored) now=\(Pasteboard.currentString() ?? "nil")")
    }

    /// The sentinel route's pure pieces and its restore rule, driven on the
    /// real pasteboard without posting any key event.
    private static func clipboardCapture() {
        let saved = Pasteboard.snapshot()
        defer { Pasteboard.restore(saved) }
        let sentinel = ClipboardCapture.makeSentinel()
        let baseline: Set<String> = ["already there"]
        check("sentinel carries the prefix", sentinel.hasPrefix(ClipboardCapture.sentinelPrefix))
        check("capture ignores the sentinel", !ClipboardCapture.isCapturedText(sentinel, sentinel: sentinel, baseline: baseline))
        check("capture ignores the baseline", !ClipboardCapture.isCapturedText("already there", sentinel: sentinel, baseline: baseline))
        check("capture ignores empty", !ClipboardCapture.isCapturedText("", sentinel: sentinel, baseline: baseline))
        check("capture accepts new text", ClipboardCapture.isCapturedText("fresh", sentinel: sentinel, baseline: baseline))

        let lineCopy = HostProfile(refused: false, lazyVerify: true, rich: false, lineCopy: true)
        let plain = HostProfile(refused: false, lazyVerify: true, rich: false, lineCopy: false)
        check("line-copy editor: bare caret line is no selection", ClipboardCapture.classify(copied: "let x = 1\n", profile: lineCopy) == .none)
        check("line-copy editor: two lines is a selection", ClipboardCapture.classify(copied: "a\nb\n", profile: lineCopy) == .selected("a\nb\n"))
        check("line-copy editor: no terminator is a selection", ClipboardCapture.classify(copied: "word", profile: lineCopy) == .selected("word"))
        check("other host: single line with newline is a selection", ClipboardCapture.classify(copied: "line\n", profile: plain) == .selected("line\n"))

        // Restore rule on the real pasteboard.
        Pasteboard.write(plain: "original clipboard", transient: false)
        let original = Pasteboard.snapshot()
        Pasteboard.write(plain: sentinel, transient: true)
        check("sentinel still on the pasteboard restores the original",
              ClipboardCapture.restoreIfOurs(original, written: [sentinel], baseline: []) && Pasteboard.currentString() == "original clipboard")
        Pasteboard.write(plain: sentinel, transient: true)
        Pasteboard.write(plain: "copied selection", transient: false)
        check("copied text on the pasteboard restores the original",
              ClipboardCapture.restoreIfOurs(original, written: [sentinel, "copied selection"], baseline: []) && Pasteboard.currentString() == "original clipboard")
        Pasteboard.write(plain: sentinel, transient: true)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("user copy during capture", forType: .string)
        check("a user copy during capture is kept",
              !ClipboardCapture.restoreIfOurs(original, written: [sentinel], baseline: []) && Pasteboard.currentString() == "user copy during capture")
        Pasteboard.write(plain: "already there", transient: false)
        check("baseline text on the pasteboard is not restored over",
              !ClipboardCapture.restoreIfOurs(original, written: [sentinel], baseline: ["already there"]))
    }

    /// Fail-closed replace path without Accessibility: every refusal maps to a
    /// chip, an identical model result never pastes, and a verify mismatch
    /// leaves the pasteboard and the undo memory untouched.
    private static func replacePath() {
        func session(_ text: String, pid: pid_t = 1, bundle: String = "com.apple.TextEdit") -> Session {
            Session(original: text, host: Host(pid: pid, bundleId: bundle, name: "Host"),
                    profile: HostPolicy.profile(for: Host(pid: pid, bundleId: bundle, name: "Host")),
                    route: .ax, axRole: kAXTextAreaRole, bounds: nil)
        }
        check("validate rejects empty capture", Replacer.validate(session("")) == .failure(.noSelection))
        check("validate rejects whitespace-only capture", Replacer.validate(session(" \n\t")) == .failure(.noSelection))
        let long = String(repeating: "\u{1F600}", count: Session.maxCodePoints + 1)
        check("validate rejects more than 6000 code points", Replacer.validate(session(long)) == .failure(.tooLong))
        let max = String(repeating: "\u{1F600}", count: Session.maxCodePoints)
        var maxAccepted = false
        if case .success(let s) = Replacer.validate(session(max)), s.original == max { maxAccepted = true }
        check("validate accepts exactly 6000 code points", maxAccepted)
        check("chip: terminal", ReplaceError.terminalRefused.chipText == "Not in terminals")
        check("chip: secure field", ReplaceError.secureField.chipText == "Not in password fields")
        check("chip: no selection", ReplaceError.noSelection.chipText == "Select text first")
        check("chip: too long", ReplaceError.tooLong.chipText == "Selection too long")
        check("chip: host changed", ReplaceError.hostChanged.chipText == "Selection changed")
        check("chip: selection changed", ReplaceError.selectionChanged.chipText == "Selection changed")
        check("chip: not trusted", ReplaceError.notTrusted.chipText == "Grant Accessibility")

        let replacer = Replacer.shared
        let countBefore = Pasteboard.changeCount

        // Target app changed: pid 1 is never frontmost.
        var outcome: Result<Void, ReplaceError>?
        replacer.replace(session("abc"), plain: "abd") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 3)
        check("replace fails closed when the target app changed", failed(outcome, with: .hostChanged), "\(String(describing: outcome))")

        // Frontmost pid but the selection cannot be re-read as the original.
        let front = Host.frontmost()?.pid ?? 1
        outcome = nil
        replacer.replace(session("arcforma-selftest-never-matches-\(UUID().uuidString)", pid: front), plain: "x") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 3)
        check("replace fails closed when the re-read differs", failed(outcome, with: .selectionChanged) || failed(outcome, with: .hostChanged),
              "\(String(describing: outcome))")

        var expired = session("abc", pid: front)
        expired.createdAt = Date(timeIntervalSinceNow: -(Session.ttl + 1))
        outcome = nil
        replacer.replace(expired, plain: "abd") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 3)
        check("replace fails closed on an expired session", failed(outcome, with: .selectionChanged), "\(String(describing: outcome))")

        outcome = nil
        replacer.replace(session("abc", pid: front), plain: "") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 3)
        check("replace refuses an empty replacement", failed(outcome, with: .emptyReplacement), "\(String(describing: outcome))")

        check("no refused replace touched the pasteboard", Pasteboard.changeCount == countBefore)
        check("no refused replace recorded an undo memory", replacer.last == nil)

        // Model result equal to the original: "No changes", never a paste.
        let ai = AIService()
        ai.daemon.configURL = tempDir.appendingPathComponent("missing-config.json")
        ai.cli.binaryOverride = stubCLI(answer: "same text")
        var registered = 0
        var action: Result<ActionOutcome, ActionFailure>?
        var ctx = ActionContext(session: session("same text", pid: front), instruction: nil, replacer: replacer, ai: ai)
        ctx.register = { _ in registered += 1 }
        ctx.captureMs = 7
        Actions.fix.perform(ctx) { action = $0 }
        wait(until: { action != nil }, timeout: 8)
        check("identical model result reports No changes", action == .success(.unchanged), "\(String(describing: action))")
        check("identical model result never pastes", Pasteboard.changeCount == countBefore && replacer.last == nil)
        check("model call handle was registered for Escape", registered == 1, "\(registered)")

        // Changed result, but verify cannot confirm the selection: fail closed.
        ai.cli.binaryOverride = stubCLI(answer: "different text")
        action = nil
        Actions.fix.perform(ctx) { action = $0 }
        wait(until: { action != nil }, timeout: 8)
        var refused = false
        if case .failure(.replace(let e))? = action, e == .selectionChanged || e == .hostChanged { refused = true }
        check("changed result with a failed verify is refused", refused, "\(String(describing: action))")
        check("refused paste left the pasteboard alone", Pasteboard.changeCount == countBefore)

        let log = logContents()
        check("timing line logged with capture, model, replace",
              log.contains("timing text.fix: capture 7 ms, model ") && log.contains(" ms, replace ") && log.contains("outcome unchanged"),
              log.suffix(400).description)
    }

    private static func daemonClient() {
        let full = Data("""
        {"port": 61612, "token": "abc123", "claudeBin": "/x/claude", "modelChain": ["a"], "concurrency": 2, "local": {"ctx": 8192}}
        """.utf8)
        let config = DaemonConfig.parse(full)
        check("daemon config parses with extra keys", config?.port == 61612 && config?.token == "abc123")
        check("daemon config rejects missing token", DaemonConfig.parse(Data(#"{"port": 1}"#.utf8)) == nil)
        check("daemon config rejects empty token", DaemonConfig.parse(Data(#"{"port": 1, "token": ""}"#.utf8)) == nil)
        check("daemon config rejects a bad port", DaemonConfig.parse(Data(#"{"port": 0, "token": "t"}"#.utf8)) == nil)
        check("daemon config rejects garbage", DaemonConfig.parse(Data("nope".utf8)) == nil)

        let path = tempDir.appendingPathComponent("daemon.json")
        try? full.write(to: path)
        let client = AIClient()
        client.configURL = path
        let req = client.request("POST", "/v1/complete", timeout: 22)
        check("daemon request carries the bearer token", req?.value(forHTTPHeaderField: "Authorization") == "Bearer abc123")
        check("daemon request targets loopback and the configured port", req?.url?.absoluteString == "http://127.0.0.1:61612/v1/complete")
        check("daemon request timeout is 20 s plus 2 s slack", req?.timeoutInterval == 22 && AIService.timeoutMs == 20_000)
        let missing = AIClient()
        missing.configURL = tempDir.appendingPathComponent("absent.json")
        check("missing config is not configured", !missing.isConfigured && missing.request("GET", "/v1/health", timeout: 1) == nil)

        func body(_ s: String) -> Data { Data(s.utf8) }
        let ok = AIClient.classify(status: 200, data: body(#"{"text":"Hi<<ARCFORMA_END>>","model":"opus","latencyMs":12}"#), error: nil, cancelled: false)
        check("classify 200", ok == .success(Completion(text: "Hi<<ARCFORMA_END>>", model: "opus", latencyMs: 12)), "\(ok)")
        let notLoggedIn = AIClient.classify(status: 503, data: body(#"{"code":"not_logged_in"}"#), error: nil, cancelled: false)
        check("classify 503 not_logged_in", notLoggedIn == .failure(.notLoggedIn), "\(notLoggedIn)")
        check("not_logged_in chip says Sign in to Claude Code", AIError.notLoggedIn.chipText == "Sign in to Claude Code")
        check("classify 503 model_unsupported", AIClient.classify(status: 503, data: body(#"{"code":"model_unsupported"}"#), error: nil, cancelled: false) == .failure(.modelUnsupported))
        check("classify 503 other code", AIClient.classify(status: 503, data: body(#"{"code":"busy"}"#), error: nil, cancelled: false) == .failure(.http(503, "busy")))
        check("classify 200 without text is an http error", AIClient.classify(status: 200, data: body("{}"), error: nil, cancelled: false) == .failure(.http(200, "{}")))
        let refused = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        check("classify connection refused", AIClient.classify(status: 0, data: nil, error: refused, cancelled: false) == .failure(.daemonUnreachable))
        let timedOut = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        check("classify timeout", AIClient.classify(status: 0, data: nil, error: timedOut, cancelled: false) == .failure(.timeout))
        check("classify cancelled wins", AIClient.classify(status: 0, data: nil, error: timedOut, cancelled: true) == .failure(.cancelled))

        check("fallback to CLI on connection refused", AIService.shouldFallBack(after: .daemonUnreachable))
        check("no fallback on 503 not_logged_in", !AIService.shouldFallBack(after: .notLoggedIn))
        check("no fallback on timeout", !AIService.shouldFallBack(after: .timeout))
        check("no fallback on model_unsupported", !AIService.shouldFallBack(after: .modelUnsupported))
        check("no fallback on http error", !AIService.shouldFallBack(after: .http(500, "")))
    }

    /// The daemon-or-direct decision end to end: connection refused falls
    /// back to the stub CLI, a 503 not_logged_in from a fake daemon does not,
    /// and aiBackend=direct skips a healthy daemon.
    private static func daemonIntegration() {
        // Connection refused: nothing listens on port 1 over loopback.
        let refusedPath = tempDir.appendingPathComponent("refused.json")
        try? Data(#"{"port": 1, "token": "t"}"#.utf8).write(to: refusedPath)
        let svc = AIService()
        svc.daemon.configURL = refusedPath
        svc.forceDirectOverride = false
        let called = tempDir.appendingPathComponent("cli-called-refused").path
        svc.cli.binaryOverride = stubCLI(answer: "via cli", calledFile: called)
        var outcome: Result<Completion, AIError>?
        svc.complete(system: "s", user: "u", task: "text.fix") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 10)
        var viaCLI = false
        if case .success(let c)? = outcome, c.text == "via cli<<ARCFORMA_END>>" { viaCLI = true }
        check("connection refused falls back to direct claude", viaCLI && FileManager.default.fileExists(atPath: called),
              "\(String(describing: outcome))")
        check("fallback is logged", logContents().contains("daemon unreachable, falling back to direct claude"))

        // Fake daemon answering 503 not_logged_in.
        let server = writeScript("fake-daemon.py", fakeDaemonSource)
        guard let daemon = FakeDaemon.start(script: server, mode: "not_logged_in", token: "tok") else {
            skip("503 not_logged_in integration", "python3 not available or the fake daemon did not start")
            return
        }
        defer { daemon.stop() }
        let cfg = tempDir.appendingPathComponent("fake.json")
        try? Data(#"{"port": \#(daemon.port), "token": "tok"}"#.utf8).write(to: cfg)
        svc.daemon.configURL = cfg
        let called503 = tempDir.appendingPathComponent("cli-called-503").path
        svc.cli.binaryOverride = stubCLI(answer: "must not run", calledFile: called503)
        outcome = nil
        svc.complete(system: "s", user: "u", task: "text.fix") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 10)
        check("503 not_logged_in maps to notLoggedIn", outcome == .failure(.notLoggedIn), "\(String(describing: outcome))")
        check("503 not_logged_in never runs the CLI", !FileManager.default.fileExists(atPath: called503))

        var health: (AIService.Backend, String)?
        svc.health { health = ($0, $1) }
        wait(until: { health != nil }, timeout: 5)
        check("health reports signed out", health?.0 == .signedOut && health?.1 == "AI: sign in to Claude Code", "\(String(describing: health))")

        // Wrong token is rejected by the daemon, and that is not a fallback case either.
        let badCfg = tempDir.appendingPathComponent("bad-token.json")
        try? Data(#"{"port": \#(daemon.port), "token": "wrong"}"#.utf8).write(to: badCfg)
        svc.daemon.configURL = badCfg
        outcome = nil
        svc.complete(system: "s", user: "u", task: "text.fix") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 10)
        check("wrong bearer token is an http error, no fallback",
              outcome == .failure(.http(401, "{\"code\": \"unauthorized\"}")) && !FileManager.default.fileExists(atPath: called503),
              "\(String(describing: outcome))")

        // aiBackend=direct: the daemon is configured and up, the CLI answers anyway.
        svc.daemon.configURL = cfg
        svc.forceDirectOverride = true
        let calledDirect = tempDir.appendingPathComponent("cli-called-direct").path
        svc.cli.binaryOverride = stubCLI(answer: "forced direct", calledFile: calledDirect)
        outcome = nil
        svc.complete(system: "s", user: "u", task: "text.fix") { outcome = $0 }
        wait(until: { outcome != nil }, timeout: 10)
        var direct = false
        if case .success(let c)? = outcome, c.text == "forced direct<<ARCFORMA_END>>" { direct = true }
        check("aiBackend=direct skips the daemon", direct && FileManager.default.fileExists(atPath: calledDirect), "\(String(describing: outcome))")
        svc.forceDirectOverride = false

        // Cancel in flight against the daemon: DELETE goes out, result is cancelled.
        guard let slowDaemon = FakeDaemon.start(script: server, mode: "slow", token: "tok") else { return }
        defer { slowDaemon.stop() }
        let slowCfg = tempDir.appendingPathComponent("slow.json")
        try? Data(#"{"port": \#(slowDaemon.port), "token": "tok"}"#.utf8).write(to: slowCfg)
        svc.daemon.configURL = slowCfg
        outcome = nil
        let handle = svc.complete(system: "s", user: "u", task: "text.fix") { outcome = $0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { handle.cancel() }
        wait(until: { outcome != nil }, timeout: 10)
        check("cancel against the daemon reports cancelled", outcome == .failure(.cancelled), "\(String(describing: outcome))")
        wait(until: { slowDaemon.deleteCount() > 0 }, timeout: 3)
        check("cancel sends DELETE /v1/complete/<id>", slowDaemon.deleteCount() == 1, "\(slowDaemon.deleteCount())")
    }

    /// Escape is registered only while a call is in flight and released on
    /// success, failure, cancel, and the synchronous-failure ordering that
    /// used to leak it.
    private static func escapeLifecycle() {
        let key = HotKey()
        check("hotkey registers", key.register(Chords.escape) {} && key.isRegistered)
        key.unregister()
        check("hotkey unregisters", !key.isRegistered)
        check("escape chord label", Chords.escape.label == "Escape")

        let inFlight = InFlightCoordinator()
        var cancels = 0
        inFlight.onCancel = { cancels += 1 }
        check("escape idle at start", !inFlight.isEscapeArmed)

        var gen = inFlight.nextGeneration()
        inFlight.begin(AIRequestHandle(), generation: gen)
        check("escape armed during a call", inFlight.isEscapeArmed && inFlight.isActive)
        inFlight.end(generation: gen)
        check("escape released after success", !inFlight.isEscapeArmed && !inFlight.isActive)

        gen = inFlight.nextGeneration()
        inFlight.begin(AIRequestHandle(), generation: gen)
        inFlight.end(generation: gen)
        check("escape released after failure", !inFlight.isEscapeArmed)

        gen = inFlight.nextGeneration()
        var cancelled = false
        inFlight.begin(AIRequestHandle(cancel: { cancelled = true }), generation: gen)
        inFlight.cancel()
        check("escape released after cancel and the handle was cancelled", !inFlight.isEscapeArmed && cancelled && cancels == 1)
        inFlight.end(generation: gen)
        check("late end after cancel is harmless", !inFlight.isEscapeArmed)

        // Synchronous failure: completion (end) runs before the handle is
        // handed back (begin). Must not arm.
        gen = inFlight.nextGeneration()
        inFlight.end(generation: gen)
        inFlight.begin(AIRequestHandle(), generation: gen)
        check("begin after end never arms escape", !inFlight.isEscapeArmed && !inFlight.isActive)

        // A stale generation cannot arm either.
        let stale = inFlight.nextGeneration()
        _ = inFlight.nextGeneration()
        inFlight.begin(AIRequestHandle(), generation: stale)
        check("stale generation never arms escape", !inFlight.isEscapeArmed)

        // The real synchronous-failure path: no daemon config and no CLI binary.
        let ai = AIService()
        ai.daemon.configURL = tempDir.appendingPathComponent("absent.json")
        ai.cli.binaryOverride = tempDir.appendingPathComponent("no-such-claude").path
        ai.forceDirectOverride = false
        var registered = 0, completed = 0
        let host = Host(pid: 1, bundleId: "com.apple.TextEdit", name: "TextEdit")
        var ctx = ActionContext(session: Session(original: "abc", host: host, profile: HostPolicy.profile(for: host),
                                                 route: .ax, axRole: nil, bounds: nil), instruction: nil, ai: ai)
        ctx.register = { _ in registered += 1 }
        Actions.fix.perform(ctx) { _ in completed += 1 }
        wait(until: { completed > 0 }, timeout: 3)
        check("synchronous backend failure never registers a handle", completed == 1 && registered == 0, "completed \(completed) registered \(registered)")

        inFlight.shutdown()
        check("shutdown leaves escape released", !inFlight.isEscapeArmed)
    }

    /// No em dashes, en dashes, or emojis in anything the app shows or logs,
    /// and in the source tree when it is next to the binary.
    private static func strings() {
        func offending(_ s: String) -> String? {
            for scalar in s.unicodeScalars {
                if scalar == "\u{2013}" || scalar == "\u{2014}" { return "dash U+\(String(scalar.value, radix: 16))" }
                if (0x1F300...0x1FAFF).contains(scalar.value) || (0x2600...0x27BF).contains(scalar.value)
                    || scalar.properties.isEmojiPresentation {
                    return "emoji U+\(String(scalar.value, radix: 16))"
                }
            }
            return nil
        }
        var shown: [String] = ["Fixing", "Editing", "Done", "No changes", "Select text first", "Cancelled",
                               "Nothing to restore", "Restored", "Undone", "Replace", "What should change",
                               "Edit with instruction", "Text tools", "Fix selection", "Restore last",
                               "Open Accessibility Settings", "Quit", "Accessibility: granted", "Accessibility: not granted"]
        shown += ReplaceError.allCases.map(\.chipText)
        shown += AIError.samples.map(\.chipText)
        shown += Actions.toolbar.map(\.title) + [Actions.undo.title]
        shown += [Prompts.fixSystem, Prompts.instructSystem]
        let bad = shown.compactMap { s in offending(s).map { "\(s): \($0)" } }
        check("no dashes or emojis in shown strings", bad.isEmpty, bad.joined(separator: "; "))
        check("buttons say what happens", Actions.toolbar.map(\.title) == ["Fix", "Edit", "Bold", "Italic", "Bullets", "Numbered"])

        // Source scan when running out of the package checkout.
        guard let root = Resources.packageRoot,
              FileManager.default.fileExists(atPath: root.appendingPathComponent("Sources/ArcformaText").path) else {
            skip("source tree dash and emoji scan", "not running from the package checkout")
            return
        }
        var hits: [String] = []
        let files = ["README.md", "build.sh", "install.sh"]
            + (try? FileManager.default.subpathsOfDirectory(atPath: root.path))!.filter {
                ($0.hasPrefix("Sources/") && $0.hasSuffix(".swift")) || ($0.hasPrefix("scripts/") && ($0.hasSuffix(".sh") || $0.hasSuffix(".py")))
            }
        for file in files {
            guard let text = try? String(contentsOf: root.appendingPathComponent(file), encoding: .utf8) else { continue }
            for (i, line) in text.components(separatedBy: "\n").enumerated() {
                // The self-test's own probe strings are allowed.
                if file.hasSuffix("SelfTest.swift"), line.contains("u{") { continue }
                if let why = offending(line) { hits.append("\(file):\(i + 1) \(why)") }
            }
        }
        check("source tree has no dashes or emojis (\(files.count) files)", hits.isEmpty, hits.prefix(5).joined(separator: "; "))
        // The scanner's own patterns live in this file.
        let sources = files.filter { $0.hasSuffix(".swift") && !$0.hasSuffix("SelfTest.swift") }
        var keyDown: [String] = []
        for file in sources {
            guard let text = try? String(contentsOf: root.appendingPathComponent(file), encoding: .utf8) else { continue }
            for (i, line) in text.components(separatedBy: "\n").enumerated() {
                if line.contains("matching: .keyDown") || line.contains("CGEvent.tapCreate") || line.contains("CGEventTapCreate")
                    || line.contains("matching: .keyUp") || line.contains("flagsChanged") {
                    keyDown.append("\(file):\(i + 1)")
                }
            }
        }
        check("no keyDown monitors or event taps in the source", keyDown.isEmpty, keyDown.joined(separator: "; "))
    }

    private static func constants() {
        check("sentinel poll 20 ms up to 1200 ms", ClipboardCapture.pollInterval == 0.020 && ClipboardCapture.timeout == 1.2)
        check("pasteboard restore after 350 ms", Replacer.restoreDelay == 0.35)
        check("session limits: 6000 code points, 5 min ttl", Session.maxCodePoints == 6000 && Session.ttl == 300)
        check("undo memory 30 s", LastReplacement.memory == 30)
        check("watcher: 6 pt drag, 150 ms settle, 250 ms poll, 12 s chromium timeout, 2 code points",
              SelectionWatcher.dragThreshold == 6 && SelectionWatcher.settleDelay == 0.15 && SelectionWatcher.pollInterval == 0.25
                && SelectionWatcher.chromiumTimeout == 12 && SelectionWatcher.minCodePoints == 2)
        check("AX messaging timeout is short", AXSelection.messagingTimeout <= 1)
        let t = Timings(task: "text.fix", captureMs: 10, modelMs: 20, replaceMs: 30, model: "opus",
                        host: "com.apple.Notes", route: .ax, outcome: "replaced")
        check("timing line format", t.line == "timing text.fix: capture 10 ms, model 20 ms, replace 30 ms, total 60 ms, outcome replaced, model opus, host com.apple.Notes, route ax", t.line)
    }

    // MARK: Fake daemon

    /// Minimal loopback daemon for the integration checks. Prints its port on
    /// the first stdout line. Modes: not_logged_in (503), ok (200), slow (200
    /// after 5 s, so a cancel lands first). Counts DELETEs at /v1/deletes.
    private static let fakeDaemonSource = """
    import sys, json, time, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    mode, token = sys.argv[1], sys.argv[2]
    deletes = 0
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def send(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if self.path == "/v1/deletes":
                self.send(200, {"deletes": deletes}); return
            self.send(200, {"ok": True, "loggedIn": mode != "not_logged_in", "model": "stub"})
        def do_POST(self):
            n = int(self.headers.get("Content-Length", "0")); self.rfile.read(n)
            if self.headers.get("Authorization", "") != "Bearer " + token:
                self.send(401, {"code": "unauthorized"}); return
            if mode == "not_logged_in":
                self.send(503, {"code": "not_logged_in"}); return
            if mode == "slow":
                time.sleep(5)
            self.send(200, {"text": "Daemon fixed.<<ARCFORMA_END>>", "model": "stub", "latencyMs": 1})
        def do_DELETE(self):
            global deletes
            deletes += 1
            self.send(200, {"ok": True})
    class Server(HTTPServer):
        daemon_threads = True
        def process_request(self, request, client_address):
            t = threading.Thread(target=self.process_request_thread, args=(request, client_address), daemon=True)
            t.start()
        def process_request_thread(self, request, client_address):
            try:
                self.finish_request(request, client_address)
            except Exception:
                pass
            finally:
                self.shutdown_request(request)
    srv = Server(("127.0.0.1", 0), H)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
    """

    private final class FakeDaemon {
        let process: Process
        let port: Int

        private init(process: Process, port: Int) { self.process = process; self.port = port }

        static func start(script: String, mode: String, token: String) -> FakeDaemon? {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["python3", script, mode, token]
            p.standardInput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            let out = Pipe()
            p.standardOutput = out
            do { try p.run() } catch { return nil }
            var line = ""
            let deadline = Date().addingTimeInterval(5)
            let reader = DispatchQueue(label: "ai.arcforma.text.selftest.fake")
            var got: String?
            reader.async {
                let data = out.fileHandleForReading.availableData
                got = String(decoding: data, as: UTF8.self)
            }
            while got == nil && Date() < deadline && p.isRunning { Thread.sleep(forTimeInterval: 0.02) }
            line = (got ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let port = Int(line), port > 0 else { p.terminate(); return nil }
            return FakeDaemon(process: p, port: port)
        }

        func deleteCount() -> Int {
            var count = -1
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/v1/deletes")!) { data, _, _ in
                if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
                    count = json["deletes"] ?? -1
                }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 3)
            return count
        }

        func stop() {
            if process.isRunning { process.terminate() }
        }
    }
}
