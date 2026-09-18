// SymbUI control panel: a small always-on-top native window (NSPanel) that
// hosts the panel web UI served on loopback, so the panel can live on the
// desktop instead of inside the page being annotated.
//
//   symbui-panel --url <http://127.0.0.1:PORT/...> [--title SymbUI]
//                [--width 380] [--height 720] [--x <int>] [--y <int>]
//
// stdout carries exactly the two lines the parent process watches for, written
// straight to the file descriptor so they are never lost in a pipe buffer:
//
//   SYMBUI_PANEL_READY <url> level=<windowLevelRawValue>
//   SYMBUI_PANEL_ERROR <one-line reason>
//
// The process exits 0 when the window is closed or on SIGINT/SIGTERM, and 1
// when the page fails to load. Compile it with scripts/native/build-panel.mjs.

import AppKit
import Dispatch
import Foundation
import WebKit

private let frameDefaultsKey = "symbui.panel.frame"
private let defaultSize = NSSize(width: 380, height: 720)
private let edgeMargin: CGFloat = 24

private func emit(_ line: String) {
    // FileHandle writes straight to fd 1: no stdio buffering to flush.
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func oneLine(_ text: String) -> String {
    let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return flat.isEmpty ? "unknown error" : String(flat.prefix(400))
}

private func fail(_ reason: String) -> Never {
    emit("SYMBUI_PANEL_ERROR \(oneLine(reason))")
    exit(2)
}

private struct Options {
    let url: URL
    let title: String
    let width: CGFloat?
    let height: CGFloat?
    let x: CGFloat?
    let y: CGFloat?
}

private func parseOptions(_ arguments: [String]) -> Options {
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
        let token = arguments[index]
        guard token.hasPrefix("--") else {
            fail("unexpected argument \(token)")
        }
        let next = index + 1 < arguments.count ? arguments[index + 1] : nil
        if let next, !next.hasPrefix("--") {
            values[String(token.dropFirst(2))] = next
            index += 2
        } else {
            values[String(token.dropFirst(2))] = ""
            index += 1
        }
    }

    guard let raw = values["url"], !raw.isEmpty, let url = URL(string: raw) else {
        fail("missing or invalid --url")
    }

    func number(_ key: String) -> CGFloat? {
        guard let raw = values[key], !raw.isEmpty else { return nil }
        guard let value = Double(raw), value.isFinite else {
            fail("--\(key) must be a number, got \(raw)")
        }
        return CGFloat(value)
    }

    let title = values["title"].flatMap { $0.isEmpty ? nil : $0 } ?? "SymbUI"
    return Options(
        url: url,
        title: title,
        width: number("width"),
        height: number("height"),
        x: number("x"),
        y: number("y")
    )
}

private final class PanelController: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate
{
    private let options: Options
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var signalSources: [DispatchSourceSignal] = []
    private var announcedReady = false
    // Set while a navigation is in flight: a remembered failure, and whether a
    // real main-frame response arrived for it.
    private var provisionalFailure: String?
    private var sawResponse = false

    init(options: Options) {
        self.options = options
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = NSPanel(
            contentRect: initialFrame(),
            styleMask: [
                .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView,
            ],
            backing: .buffered,
            defer: false
        )
        panel.title = options.title
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        // Floating: above normal windows, and present on every Space.
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 260, height: 220)
        panel.delegate = self

        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        // No uiDelegate on purpose: JS alert/confirm/prompt stay inert instead
        // of blocking the panel.
        panel.contentView?.addSubview(webView)

        self.panel = panel
        self.webView = webView

        installSignalHandlers()
        panel.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: options.url))
    }

    // MARK: - Frame persistence

    private func storedFrame() -> NSRect? {
        guard let text = UserDefaults.standard.string(forKey: frameDefaultsKey) else {
            return nil
        }
        let rect = NSRectFromString(text)
        guard rect.width >= 100, rect.height >= 100 else { return nil }
        return rect
    }

    private func defaultFrame() -> NSRect {
        let visible =
            (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(origin: .zero, size: defaultSize)
        return NSRect(
            x: visible.maxX - defaultSize.width - edgeMargin,
            y: visible.maxY - defaultSize.height - edgeMargin,
            width: defaultSize.width,
            height: defaultSize.height
        )
    }

    // The remembered frame, then whatever --x/--y/--width/--height made explicit.
    private func initialFrame() -> NSRect {
        var frame = storedFrame() ?? defaultFrame()
        if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) {
            // Remembered on a display that is not attached right now.
            frame.origin = defaultFrame().origin
        }
        if let width = options.width { frame.size.width = width }
        if let height = options.height { frame.size.height = height }
        if let x = options.x { frame.origin.x = x }
        if let y = options.y { frame.origin.y = y }
        return frame
    }

    private func saveFrame() {
        guard let panel else { return }
        UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: frameDefaultsKey)
    }

    func windowDidMove(_ notification: Notification) {
        saveFrame()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        saveFrame()
    }

    func windowWillClose(_ notification: Notification) {
        saveFrame()
        exit(0)
    }

    // MARK: - Signals

    private func installSignalHandlers() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                self?.saveFrame()
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        provisionalFailure = nil
        sawResponse = false
    }

    // A main-frame response is what tells a real load apart from the error page
    // WebKit substitutes when the server cannot be reached: that page commits and
    // finishes like any other, but no response ever arrives for it.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame { sawResponse = true }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !announcedReady else { return }
        // A load that finishes without a main-frame response never reached the
        // server: what committed is the error page WebKit substitutes, which
        // reports itself as a finished navigation like any other.
        if isHTTP, !sawResponse {
            fail(provisionalFailure ?? "no response from \(options.url.absoluteString)")
        }
        announcedReady = true
        let level = panel?.level.rawValue ?? NSWindow.Level.floating.rawValue
        emit("SYMBUI_PANEL_READY \(options.url.absoluteString) level=\(level)")
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        fail(error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        if (error as NSError).code == NSURLErrorCancelled {
            // WebKit cancels a provisional load both when a newer load replaces it
            // and when it swaps in its own error page. didFinish tells them apart,
            // so the cancellation is only remembered here.
            provisionalFailure = "the page could not be reached"
            return
        }
        fail(error.localizedDescription)
    }

    private var isHTTP: Bool {
        let scheme = options.url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    private func fail(_ reason: String) {
        // Once the panel is up, a later navigation that fails is the page's
        // business, not a reason to take the window down.
        guard !announcedReady else { return }
        saveFrame()
        emit("SYMBUI_PANEL_ERROR \(oneLine(reason))")
        exit(1)
    }
}

private let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
let application = NSApplication.shared
private let controller = PanelController(options: options)
application.delegate = controller
// Accessory: floating UI, no Dock icon, no menu bar of its own.
application.setActivationPolicy(.accessory)
application.run()
