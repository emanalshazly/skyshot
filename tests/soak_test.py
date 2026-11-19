"""SKYSHOT booth soak test.

Plays many back-to-back rounds in a real Chromium browser and checks the three things
the Category 3 judging asks for: a complete game loop, a clean reset between players,
and steady responsiveness under repeated use. A second window runs the leaderboard
monitor and must stay in sync with no network.

Usage:
    pip install playwright && playwright install chromium   # once
    python tests/soak_test.py --rounds 20 --round-seconds 8

Exit code 0 means every check passed. Results are printed and written to
tests/soak_report.json; screenshots go to tests/screens/.
"""

import argparse
import functools
import http.server
import json
import pathlib
import random
import socketserver
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCREENS = ROOT / "tests" / "screens"


def serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def launch_kwargs():
    """Use Playwright's bundled Chromium if installed, otherwise a system Chrome."""
    import shutil
    for exe in ("google-chrome", "chromium", "chromium-browser"):
        path = shutil.which(exe)
        if path and not (pathlib.Path.home() / ".cache" / "ms-playwright").exists():
            return {"executable_path": path}
    return {}


def wait_mode(page, mode, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate("window.__SKYSHOT__.mode()") == mode:
            return True
        time.sleep(0.05)
    return False


def board_rows(board):
    return board.evaluate("document.querySelectorAll('#table tr:not(:has(.empty))').length")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=20)
    ap.add_argument("--round-seconds", type=int, default=8)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    SCREENS.mkdir(parents=True, exist_ok=True)
    httpd = serve(args.port)
    base = f"http://127.0.0.1:{args.port}"
    url = f"{base}/index.html?test=1&round={args.round_seconds}&idle=4&return=3"

    failures = []
    rounds = []
    rng = random.Random(9)

    def check(cond, msg):
        if not cond:
            failures.append(msg)
            print("  FAIL:", msg)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--enable-precise-memory-info"], **launch_kwargs())
        context = browser.new_context(viewport={"width": 1600, "height": 900})
        # Simulate a booth with no internet: block everything that is not the local server.
        context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())

        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(url)
        page.evaluate("localStorage.clear()")
        page.reload()

        board = context.new_page()
        board.goto(f"{base}/leaderboard.html")

        check(wait_mode(page, "attract", 5), "game did not boot into attract mode")
        page.bring_to_front()
        page.screenshot(path=str(SCREENS / "01_attract.png"))
        heap_start = page.evaluate("performance.memory ? performance.memory.usedJSHeapSize : 0")

        for i in range(args.rounds):
            info = {"round": i + 1}
            # --- start: from attract by click, or via PLAY AGAIN on odd rounds ---
            mode = page.evaluate("window.__SKYSHOT__.mode()")
            if mode == "attract":
                time.sleep(1.3)  # input guard
                page.mouse.click(800, 450)
            check(wait_mode(page, "countdown", 5), f"round {i+1}: never reached countdown")
            snap = page.evaluate("window.__SKYSHOT__.snapshot()")
            # --- clean reset checks ---
            check(snap["score"] == 0, f"round {i+1}: score not reset ({snap['score']})")
            check(snap["shots"] == 0 and snap["hits"] == 0, f"round {i+1}: shot counters not reset")
            check(snap["combo"] == 0, f"round {i+1}: combo not reset")
            check(len(snap["targets"]) == 0, f"round {i+1}: targets left over from previous round")
            check(snap["result"] is None and not snap["saved"], f"round {i+1}: previous result leaked")

            check(wait_mode(page, "play", 6), f"round {i+1}: never reached play")
            # --- play: a "player" with varying skill hits targets and sometimes misses ---
            skill = 0.55 + 0.4 * rng.random()
            shot_lat = []
            t_end = time.time() + args.round_seconds + 2
            took_play_shot = False
            while time.time() < t_end and page.evaluate("window.__SKYSHOT__.mode()") == "play":
                snap = page.evaluate("window.__SKYSHOT__.snapshot()")
                if snap["targets"] and rng.random() < 0.6:
                    t = rng.choice(snap["targets"])
                    if rng.random() < skill:
                        x, y = t["x"], t["y"]
                    else:
                        x, y = t["x"] + t["r"] * 3, t["y"] + t["r"] * 3  # a miss
                    t0 = time.time()
                    page.mouse.click(x, y)
                    shot_lat.append((time.time() - t0) * 1000)
                    if i == 0 and not took_play_shot and snap["shots"] >= 6:
                        page.screenshot(path=str(SCREENS / "02_play.png"))
                        took_play_shot = True
                time.sleep(0.08 + rng.random() * 0.12)

            check(wait_mode(page, "results", 5), f"round {i+1}: never reached results")
            snap = page.evaluate("window.__SKYSHOT__.snapshot()")
            res = snap["result"]
            check(res is not None, f"round {i+1}: no result object")
            if res:
                info.update({k: res[k] for k in ("score", "accuracy", "reaction", "combo", "rank")})
                check(res["shots"] == snap["shots"], f"round {i+1}: shot count mismatch")
            if i == 0:
                page.screenshot(path=str(SCREENS / "03_results.png"))

            rows_before = board_rows(board)
            # --- leaving results: three paths, so all of them get exercised ---
            path = ["save_click", "idle_autosave", "play_again"][i % 3]
            qualifies = res and res["rank"] <= 10
            info["exit"] = path
            if qualifies and path != "idle_autosave":
                time.sleep(1.3)
                # pick initials with arrow keys, then save
                for _ in range(rng.randint(0, 5)):
                    page.keyboard.press("ArrowDown")
                page.keyboard.press("Enter")
            # wait until saved (immediately if not qualifying, or after idle auto-save)
            end = time.time() + 10
            while time.time() < end and not page.evaluate("window.__SKYSHOT__.snapshot().saved"):
                time.sleep(0.1)
            check(page.evaluate("window.__SKYSHOT__.snapshot().saved"), f"round {i+1}: score never saved ({path})")
            if i == 0 and qualifies:
                page.screenshot(path=str(SCREENS / "04_saved.png"))

            if path == "play_again":
                time.sleep(1.3)
                page.keyboard.press("Enter")  # PLAY AGAIN shortcut
            else:
                check(wait_mode(page, "attract", 12), f"round {i+1}: did not return to attract")

            # leaderboard window must reflect the new score within ~2.5s (offline)
            if qualifies:
                end = time.time() + 3
                synced = False
                while time.time() < end:
                    if board_rows(board) >= min(rows_before + 1, 10) or rows_before >= 10:
                        synced = True
                        break
                    time.sleep(0.1)
                check(synced, f"round {i+1}: leaderboard monitor did not update")

            info["click_latency_ms_p95"] = round(sorted(shot_lat)[int(0.95 * (len(shot_lat) - 1))], 1) if shot_lat else None
            fs = page.evaluate("window.__SKYSHOT__.frameStats()")
            info["frame_p95_ms"] = round(fs["p95"], 2)
            rounds.append(info)
            print(f"round {i+1:>2}: score={info.get('score')} acc={info.get('accuracy')}% rank={info.get('rank')} "
                  f"exit={path} frame_p95={info['frame_p95_ms']}ms")

        wait_mode(page, "attract", 12)
        heap_end = page.evaluate("performance.memory ? performance.memory.usedJSHeapSize : 0")
        snap = page.evaluate("window.__SKYSHOT__.snapshot()")
        check(snap["liveParticles"] <= 320 and snap["liveFloaters"] <= 40, "effect pools grew past their caps")
        stored = page.evaluate("JSON.parse(localStorage.getItem('skyshot.scores.' + SkyStore.dayKey()) || '[]').length")
        check(stored == args.rounds, f"expected {args.rounds} stored runs, found {stored}")
        time.sleep(2.2)
        foot = board.evaluate("document.getElementById('foot').textContent")
        top_score = page.evaluate("SkyStore.top(1)[0].score")
        check(str(top_score) in foot, f"monitor all-time best stale: '{foot}' vs top {top_score}")
        board.bring_to_front()
        board.screenshot(path=str(SCREENS / "05_leaderboard.png"))
        fs = page.evaluate("window.__SKYSHOT__.frameStats()")
        check(not errors, f"browser errors: {errors[:3]}")

        report = {
            "rounds": args.rounds,
            "round_seconds": args.round_seconds,
            "offline": "all non-local requests blocked",
            "stored_runs": stored,
            "frame_ms_last_600": {k: round(v, 2) for k, v in fs.items()},
            "heap_bytes_start": heap_start,
            "heap_bytes_end": heap_end,
            "browser_errors": errors,
            "failures": failures,
            "per_round": rounds,
            "passed": not failures,
        }
        (ROOT / "tests" / "soak_report.json").write_text(json.dumps(report, indent=2))
        browser.close()

    httpd.shutdown()
    print("\nheap start/end (bytes):", heap_start, heap_end)
    print("frame ms (last 600 frames):", report["frame_ms_last_600"])
    print("RESULT:", "PASS" if not failures else f"FAIL ({len(failures)} issues)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
