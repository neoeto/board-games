#!/usr/bin/env python3
"""Stdlib-only local UCI experiment. Never adjudicates domestic-2020 games.

python3 experiments/pikafish/probe.py --engine /tmp/.../Pikafish-MacOS-universal \
  --model /tmp/.../pikafish.nnue --output experiments/pikafish/evidence.json
"""
import argparse
import hashlib
import json
import platform
import queue
import re
import resource
import statistics
import subprocess
import threading
import time
from pathlib import Path


class Engine:
    def __init__(self, executable, model):
        self.started = time.perf_counter()
        self.events = []
        self.lines = queue.Queue()
        self.process = subprocess.Popen(
            [str(executable)], cwd=model.parent, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\n"))
        self.lines.put(None)

    def send(self, command):
        self.events.append({"at_ms": self.elapsed(), "direction": "in", "line": command})
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def elapsed(self):
        return round((time.perf_counter() - self.started) * 1000, 3)

    def until(self, prefix, timeout=15):
        end = time.perf_counter() + timeout
        result = []
        while True:
            remaining = end - time.perf_counter()
            if remaining <= 0:
                raise TimeoutError(f"Waiting for {prefix}")
            line = self.lines.get(timeout=remaining)
            if line is None:
                raise RuntimeError(f"Engine EOF waiting for {prefix}: {result[-8:]}")
            self.events.append({"at_ms": self.elapsed(), "direction": "out", "line": line})
            result.append(line)
            if "CRITICAL ERROR" in line:
                raise RuntimeError(line)
            if line.startswith(prefix):
                return result

    def ready(self):
        self.send("isready")
        return self.until("readyok")

    def reset(self):
        started = time.perf_counter()
        self.send("ucinewgame")
        self.ready()
        return round((time.perf_counter() - started) * 1000, 3)

    def search(self, position, limit):
        self.send(position)
        started = time.perf_counter()
        self.send("go " + limit)
        lines = self.until("bestmove")
        return {"position": position, "limit": limit,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
                "bestmove": lines[-1].split()[1], "output": lines}

    def board(self):
        self.send("d")
        lines = self.ready()
        return next(line[5:] for line in lines if line.startswith("Fen: "))

    def legal_moves(self):
        self.send("go perft 1")
        lines = self.until("Nodes searched:")
        return [line.split(":")[0] for line in lines
                if re.fullmatch(r"[a-i][0-9][a-i][0-9]: 1", line)]

    def rss_kib(self):
        return int(subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(self.process.pid)], text=True).strip())

    def close(self):
        if self.process.poll() is None:
            self.send("quit")
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        return self.process.returncode


def identity(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def stable_search(result):
    line = next(line for line in reversed(result["output"]) if line.startswith("info depth"))
    return {"bestmove": result["bestmove"],
            "score": re.search(r"score (cp|mate) -?\d+", line).group(),
            "pv": line.split(" pv ")[-1],
            "nodes": int(re.search(r"nodes (\d+)", line).group(1))}


def run(args):
    engine_path = args.engine.resolve()
    model_path = args.model.resolve()
    evidence = {"environment": {"platform": platform.platform(), "machine": platform.machine(),
                               "python": platform.python_version(), "timing_scope": "local macOS arm64; NOT Cloudflare"},
                "engine": identity(engine_path), "model": identity(model_path),
                "settings": {"Threads": 1, "Hash_MiB": 64, "Ponder": False},
                "coverage_note": "Protocol integration and engine self-consistency only; no independent legal-move oracle or domestic-2020 adjudicator."}
    engine = Engine(engine_path, model_path)
    try:
        engine.send("uci")
        evidence["handshake"] = {"output": engine.until("uciok"), "elapsed_ms": engine.elapsed()}
        for command in ["setoption name Threads value 1", "setoption name Hash value 64",
                        "setoption name Ponder value false", "setoption name EvalFile value " + str(model_path)]:
            engine.send(command)
        engine.ready()
        evidence["configured_ready_ms"] = engine.elapsed()
        evidence["rss_ready_kib"] = engine.rss_kib()
        engine.reset()
        baseline = engine.search("position startpos", "depth 10")
        evidence["startpos_depth10"] = baseline
        initial_fen = engine.board()
        evidence["initial_fen"] = initial_fen
        evidence["startpos_legal_moves"] = engine.legal_moves()
        assert baseline["bestmove"] in evidence["startpos_legal_moves"]
        evidence["bounded_startpos"] = engine.search("position startpos", "movetime 250")
        history = "position startpos moves h2e2 h9g7 h0g2 g6g5"
        engine.reset()
        evidence["history"] = engine.search(history, "depth 10")
        evidence["history"]["fen"] = engine.board()
        evidence["history"]["legal_moves"] = engine.legal_moves()
        assert evidence["history"]["bestmove"] in evidence["history"]["legal_moves"]
        engine.send("position startpos")
        engine.send("go infinite")
        time.sleep(0.2)
        ping_start = time.perf_counter()
        ping = engine.ready()
        assert not any(line.startswith("bestmove") for line in ping)
        stop_start = time.perf_counter()
        engine.send("stop")
        stopped = engine.until("bestmove", timeout=3)
        evidence["cancellation"] = {
            "infinite_before_ping_ms": 200,
            "ping_while_searching_ms": round((stop_start - ping_start) * 1000, 3),
            "stop_to_bestmove_ms": round((time.perf_counter() - stop_start) * 1000, 3),
            "output_before_stop": ping, "output_after_stop": stopped}
        assert sum(line.startswith("bestmove") for line in stopped) == 1
        evidence["reset_ready_ms"] = engine.reset()
        reset_search = engine.search("position startpos", "depth 10")
        evidence["reset_search"] = reset_search
        evidence["reset_isolation"] = {"initial": stable_search(baseline), "after_other_game": stable_search(reset_search),
                                       "fen_restored": engine.board() == initial_fen}
        evidence["reset_isolation"]["same_search"] = stable_search(baseline) == stable_search(reset_search)
        assert evidence["reset_isolation"]["same_search"]
        assert evidence["reset_isolation"]["fen_restored"]
        engine.reset()
        moves, plies, seen = [], [], {}
        start = time.perf_counter()
        termination = "ply_cap_without_terminal"
        for ply in range(args.max_plies + 1):
            position = "position startpos" + (" moves " + " ".join(moves) if moves else "")
            engine.send(position)
            fen = engine.board()
            key = " ".join(fen.split()[:2])
            seen[key] = seen.get(key, 0) + 1
            legal = engine.legal_moves()
            if not legal:
                termination = "no_legal_moves_per_engine_perft"
                evidence["terminal_search"] = engine.search(position, "depth 1")
                break
            if seen[key] == 3:
                termination = "third_position_occurrence_observed_no_formal_verdict"
                break
            pieces = fen.split()[0]
            if not any(piece in pieces for piece in "rncphRNCPh"):
                termination = "only_kings_advisors_elephants_observed"
                break
            if ply == args.max_plies:
                break
            result = engine.search(position, "movetime " + str(args.selfplay_ms))
            assert result["bestmove"] in legal, result
            moves.append(result["bestmove"])
            plies.append({"ply": ply + 1, "move": result["bestmove"], "elapsed_ms": result["elapsed_ms"],
                          "last_info": next((line for line in reversed(result["output"]) if line.startswith("info depth")), None)})
        latencies = sorted(p["elapsed_ms"] for p in plies)
        evidence["selfplay"] = {"requested_movetime_ms": args.selfplay_ms, "max_plies": args.max_plies,
                                "elapsed_ms": round((time.perf_counter() - start) * 1000, 3),
                                "termination": termination, "formal_result": None, "final_fen": fen,
                                "plies": plies, "moves": moves, "all_moves_in_engine_legal_set": True,
                                "search_latency_ms": {"median": statistics.median(latencies),
                                                      "p95": latencies[min(len(latencies) - 1, int(len(latencies) * .95))],
                                                      "max": max(latencies)}}
        evidence["rss_after_selfplay_kib"] = engine.rss_kib()
        evidence["success"] = True
    except Exception as error:
        evidence["success"] = False
        evidence["error"] = repr(error)
        raise
    finally:
        evidence["exit_code"] = engine.close()
        evidence["transcript"] = engine.events
        evidence["child_peak_rss_raw"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        evidence["child_peak_rss_note"] = "macOS reports bytes; RUSAGE_CHILDREN max includes ps subprocesses, not an exclusive engine sampler"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: evidence[key] for key in ["success", "configured_ready_ms", "rss_ready_kib", "rss_after_selfplay_kib", "reset_isolation"]}, indent=2))
    print(json.dumps({key: evidence["selfplay"][key] for key in ["termination", "elapsed_ms", "search_latency_ms"]}, indent=2))
    print("plies:", len(evidence["selfplay"]["moves"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selfplay-ms", type=int, default=30)
    parser.add_argument("--max-plies", type=int, default=600)
    run(parser.parse_args())
