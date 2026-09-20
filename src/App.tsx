import { useEffect, useRef, useState } from "react";
import { GoBoard } from "./components/GoBoard";
import { XiangqiBoard } from "./components/XiangqiBoard";
import { chooseGoMove } from "./engines/go/browserGoAi";
import { chooseXiangqiMove } from "./engines/xiangqi/browserXiangqiAi";
import {
  createGoState,
  playGoMove,
  type GoMove,
  type GoState,
} from "./games/go";
import type { Difficulty } from "./games/shared";
import {
  createXiangqiState,
  isXiangqiInCheck,
  playXiangqiMove,
  type XiangqiMove,
  type XiangqiState,
} from "./games/xiangqi";

type GameId = "go" | "xiangqi";
type EngineName = "katago" | "pikafish" | "local";

interface EngineReport {
  readonly game: GameId;
  readonly engine: EngineName;
  readonly detail: string;
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "轻松",
  normal: "标准",
  hard: "强劲",
};

function engineLabel(engine: EngineName): string {
  if (engine === "katago") return "KataGo 浏览器引擎";
  if (engine === "pikafish") return "Pikafish 浏览器引擎";
  return "本地规则搜索";
}

function App() {
  const [game, setGame] = useState<GameId>("go");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [goSize, setGoSize] = useState<9 | 13 | 19>(9);
  const [goTimeline, setGoTimeline] = useState<GoState[]>(() => [createGoState(9)]);
  const [xiangqiTimeline, setXiangqiTimeline] = useState<XiangqiState[]>(() => [createXiangqiState()]);
  const [aiBusy, setAiBusy] = useState(false);
  const [message, setMessage] = useState("你执黑，请在棋盘上落子。");
  const [error, setError] = useState<string | null>(null);
  const [engineReport, setEngineReport] = useState<EngineReport | null>(null);
  const [boardEpoch, setBoardEpoch] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const goState = goTimeline[goTimeline.length - 1];
  const xiangqiState = xiangqiTimeline[xiangqiTimeline.length - 1];

  function cancelAi(): void {
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setAiBusy(false);
  }

  useEffect(() => () => {
    requestRef.current += 1;
    abortRef.current?.abort();
  }, []);

  async function requestGoReply(position: GoState): Promise<void> {
    if (position.status !== "playing" || position.turn !== "white") return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusy(true);
    setMessage("白方正在思考…");
    setError(null);

    try {
      const answer = await chooseGoMove(position, difficulty, controller.signal);
      if (request !== requestRef.current || controller.signal.aborted) return;
      const result = playGoMove(position, answer.move);
      if (!result.ok) {
        setError(`电脑返回了无效着法：${result.error}`);
        setMessage("电脑着法未能执行，请悔棋或重新开始。");
        return;
      }
      setGoTimeline((timeline) =>
        timeline[timeline.length - 1] === position ? [...timeline, result.state] : timeline,
      );
      setEngineReport({ game: "go", engine: answer.engine, detail: answer.detail });
      setMessage(result.state.status === "finished" ? "双方连续停一手，棋局结束。" : "轮到你执黑落子。");
    } catch (reason) {
      if (controller.signal.aborted || request !== requestRef.current) return;
      const detail = reason instanceof Error ? reason.message : "未知错误";
      setError(`电脑思考失败：${detail}`);
      setMessage("可悔棋后重试，或重新开始。");
    } finally {
      if (request === requestRef.current) {
        abortRef.current = null;
        setAiBusy(false);
      }
    }
  }

  async function requestXiangqiReply(position: XiangqiState): Promise<void> {
    if (position.status !== "playing" || position.turn !== "black") return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusy(true);
    setMessage("黑方正在思考…");
    setError(null);

    try {
      const answer = await chooseXiangqiMove(position, difficulty, controller.signal);
      if (request !== requestRef.current || controller.signal.aborted) return;
      const result = playXiangqiMove(position, answer.move);
      if (!result.ok) {
        setError(`电脑返回了无效着法：${result.error}`);
        setMessage("电脑着法未能执行，请悔棋或重新开始。");
        return;
      }
      setXiangqiTimeline((timeline) =>
        timeline[timeline.length - 1] === position ? [...timeline, result.state] : timeline,
      );
      setEngineReport({ game: "xiangqi", engine: answer.engine, detail: answer.detail });
      if (result.state.status === "playing") {
        setMessage(isXiangqiInCheck(result.state, "red") ? "红方被将军，请应将。" : "轮到你执红方走棋。");
      } else {
        setMessage("棋局结束，可悔棋复盘或重新开始。");
      }
    } catch (reason) {
      if (controller.signal.aborted || request !== requestRef.current) return;
      const detail = reason instanceof Error ? reason.message : "未知错误";
      setError(`电脑思考失败：${detail}`);
      setMessage("可悔棋后重试，或重新开始。");
    } finally {
      if (request === requestRef.current) {
        abortRef.current = null;
        setAiBusy(false);
      }
    }
  }

  function playHumanGoMove(move: GoMove): void {
    if (aiBusy || goState.turn !== "black") return;
    const result = playGoMove(goState, move);
    if (!result.ok) {
      setError(result.error);
      setMessage("这步不能下，请选择其他交叉点。");
      return;
    }
    setError(null);
    setGoTimeline((timeline) => [...timeline, result.state]);
    setMessage(result.state.status === "finished" ? "双方连续停一手，棋局结束。" : "黑方已落子，等待白方回应。");
    if (result.state.status === "playing") void requestGoReply(result.state);
  }

  function passGoTurn(): void {
    if (aiBusy || goState.turn !== "black" || goState.status !== "playing") return;
    const result = playGoMove(goState, "pass");
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setGoTimeline((timeline) => [...timeline, result.state]);
    setMessage(result.state.status === "finished" ? "双方连续停一手，棋局结束。" : "你已停一手，等待白方回应。");
    if (result.state.status === "playing") void requestGoReply(result.state);
  }

  function playHumanXiangqiMove(move: XiangqiMove): boolean {
    if (aiBusy || xiangqiState.turn !== "red") return false;
    const result = playXiangqiMove(xiangqiState, move);
    if (!result.ok) {
      setError(result.error);
      setMessage("这步不能走，请重新选择。");
      return false;
    }
    setError(null);
    setXiangqiTimeline((timeline) => [...timeline, result.state]);
    setMessage(result.state.status === "playing" ? "红方已走棋，等待黑方回应。" : "棋局结束。");
    if (result.state.status === "playing") void requestXiangqiReply(result.state);
    return true;
  }

  function chooseGame(nextGame: GameId): void {
    if (nextGame === game) return;
    cancelAi();
    setGame(nextGame);
    setError(null);
    setMessage(nextGame === "go" ? "你执黑，请在棋盘上落子。" : "你执红，请先选择棋子，再选择落点。");
  }

  function restartGame(): void {
    cancelAi();
    setError(null);
    setEngineReport(null);
    setBoardEpoch((value) => value + 1);
    if (game === "go") {
      setGoTimeline([createGoState(goSize)]);
      setMessage("新局开始。你执黑，请落子。");
    } else {
      setXiangqiTimeline([createXiangqiState()]);
      setMessage("新局开始。你执红，请走棋。");
    }
  }

  function undoTurn(): void {
    cancelAi();
    setError(null);
    setEngineReport(null);
    setBoardEpoch((value) => value + 1);
    if (game === "go") {
      setGoTimeline((timeline) => {
        for (let index = timeline.length - 2; index >= 0; index -= 1) {
          if (timeline[index].status === "playing" && timeline[index].turn === "black") {
            return timeline.slice(0, index + 1);
          }
        }
        return [timeline[0]];
      });
      setMessage("已撤销上一完整回合，轮到黑方。");
    } else {
      setXiangqiTimeline((timeline) => {
        for (let index = timeline.length - 2; index >= 0; index -= 1) {
          if (timeline[index].status === "playing" && timeline[index].turn === "red") {
            return timeline.slice(0, index + 1);
          }
        }
        return [timeline[0]];
      });
      setMessage("已撤销上一完整回合，轮到红方。");
    }
  }

  function changeGoSize(size: 9 | 13 | 19): void {
    cancelAi();
    setGoSize(size);
    setGoTimeline([createGoState(size)]);
    setBoardEpoch((value) => value + 1);
    setEngineReport(null);
    setError(null);
    setMessage(`已开始 ${size} 路新局，你执黑。`);
  }

  const visibleReport = engineReport?.game === game ? engineReport : null;
  const currentTimeline = game === "go" ? goTimeline : xiangqiTimeline;
  const goFinished = goState.status === "finished" && goState.score;
  const xiangqiStatus = xiangqiState.status === "checkmate"
    ? `将死，${xiangqiState.winner === "red" ? "红方" : "黑方"}胜`
    : xiangqiState.status === "stalemate"
      ? `困毙，${xiangqiState.winner === "red" ? "红方" : "黑方"}胜`
      : xiangqiState.status === "draw"
        ? "三次同形，和棋"
        : isXiangqiInCheck(xiangqiState, xiangqiState.turn)
          ? `${xiangqiState.turn === "red" ? "红方" : "黑方"}被将军`
          : `${xiangqiState.turn === "red" ? "红方" : "黑方"}行棋`;

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="弈室首页">
          <span className="brand-mark" aria-hidden="true">弈</span>
          <span><strong>弈室</strong><small>JUST GO</small></span>
        </div>
        <p>规则与电脑均在本机浏览器运行</p>
      </header>

      <main className="main-content">
        <section className="game-heading" aria-labelledby="page-title">
          <div>
            <p className="kicker">两种古典棋局，一张安静棋桌</p>
            <h1 id="page-title">围棋与中国象棋</h1>
          </div>
          <p>无需账户，无需联网对局。你执先手，电脑在浏览器内应战。</p>
        </section>

        <nav className="game-tabs" aria-label="选择棋类">
          <button aria-pressed={game === "go"} className={game === "go" ? "is-active" : ""} onClick={() => chooseGame("go")} type="button">
            <span>圍棋</span><small>GO</small>
          </button>
          <button aria-pressed={game === "xiangqi"} className={game === "xiangqi" ? "is-active" : ""} onClick={() => chooseGame("xiangqi")} type="button">
            <span>象棋</span><small>XIANGQI</small>
          </button>
        </nav>

        <section className="play-room" aria-label={game === "go" ? "围棋对局" : "中国象棋对局"}>
          <aside className="control-rail">
            <div className="control-heading">
              <p className="kicker">对局设置</p>
              <h2>{game === "go" ? "執黑而行" : "紅先黑後"}</h2>
              <p>{game === "go" ? "以围地与活子计算中国数子法得分。" : "过河攻守，将帅不可照面。"}</p>
            </div>

            <div className="field-row">
              <label htmlFor="difficulty">电脑强度</label>
              <select id="difficulty" disabled={aiBusy} value={difficulty} onChange={(event) => setDifficulty(event.target.value as Difficulty)}>
                {(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((level) => (
                  <option key={level} value={level}>{DIFFICULTY_LABELS[level]}</option>
                ))}
              </select>
            </div>

            {game === "go" ? (
              <div className="field-row">
                <label htmlFor="board-size">棋盘路数</label>
                <select id="board-size" disabled={aiBusy} value={goSize} onChange={(event) => changeGoSize(Number(event.target.value) as 9 | 13 | 19)}>
                  <option value={9}>9 路</option>
                  <option value={13}>13 路</option>
                  <option value={19}>19 路</option>
                </select>
              </div>
            ) : null}

            <div className="action-row">
              <button className="primary-action" disabled={currentTimeline.length <= 1} onClick={undoTurn} type="button">悔棋一回合</button>
              <button className="secondary-action" onClick={restartGame} type="button">重新开始</button>
            </div>
            {game === "go" ? (
              <button className="pass-action" disabled={aiBusy || goState.turn !== "black" || goState.status !== "playing"} onClick={passGoTurn} type="button">
                停一手
              </button>
            ) : null}

            <div className="status-block" aria-live="polite">
              <p className="status-label">当前局面</p>
              <strong>{game === "go" ? (goFinished ? `${goFinished.winner === "black" ? "黑方" : "白方"}胜 ${goFinished.margin} 子` : `${goState.turn === "black" ? "黑方" : "白方"}行棋`) : xiangqiStatus}</strong>
              <p>{message}</p>
              {aiBusy ? <div className="thinking-bar" role="status"><span />电脑计算中</div> : null}
              {error ? <p className="error-message" role="alert">{error}</p> : null}
            </div>

            <dl className="metrics">
              {game === "go" ? (
                <>
                  <div><dt>黑方提子</dt><dd>{goState.captures.black}</dd></div>
                  <div><dt>白方提子</dt><dd>{goState.captures.white}</dd></div>
                  <div><dt>手数</dt><dd>{goState.moveNumber}</dd></div>
                  <div><dt>贴目</dt><dd>7.5</dd></div>
                </>
              ) : (
                <>
                  <div><dt>回合手数</dt><dd>{xiangqiState.moveNumber}</dd></div>
                  <div><dt>执子</dt><dd>红方</dd></div>
                </>
              )}
            </dl>

            {visibleReport ? (
              <div className="engine-report">
                <span>上一着来源</span>
                <strong>{engineLabel(visibleReport.engine)}</strong>
                <p>{visibleReport.detail}</p>
              </div>
            ) : (
              <div className="engine-report is-empty"><span>上一着来源</span><p>电脑应手后将在这里标明实际使用的引擎。</p></div>
            )}
          </aside>

          <div className="board-panel">
            <div className="board-title">
              <div><span>{game === "go" ? `${goSize} 路棋盘` : "九路十线"}</span><strong>{game === "go" ? "圍棋" : "中國象棋"}</strong></div>
              <p>{game === "go" ? "你执黑" : "你执红"}</p>
            </div>
            {game === "go" ? (
              <GoBoard disabled={aiBusy || goState.turn !== "black" || goState.status !== "playing"} onMove={playHumanGoMove} state={goState} />
            ) : (
              <XiangqiBoard
                disabled={aiBusy || xiangqiState.turn !== "red" || xiangqiState.status !== "playing"}
                key={`${boardEpoch}-${xiangqiState.moveNumber}`}
                onMessage={(nextMessage) => { setError(null); setMessage(nextMessage); }}
                onMove={playHumanXiangqiMove}
                state={xiangqiState}
              />
            )}
            {game === "go" && goFinished ? (
              <div className="score-sheet" aria-label="终局计分">
                <div><span>黑方</span><strong>{goFinished.black}</strong><small>活子 {goFinished.stones.black} · 地 {goFinished.territory.black}</small></div>
                <div><span>白方</span><strong>{goFinished.white}</strong><small>活子 {goFinished.stones.white} · 地 {goFinished.territory.white} · 贴 7.5</small></div>
              </div>
            ) : null}
            {game === "xiangqi" ? (
              <p className="rules-note">采用基本走法、将军、将死、困毙与三次同形按简化和棋处理。中国象棋竞赛规则中的长将、长捉等高级裁决不在本局状态模型内。</p>
            ) : (
              <p className="rules-note">采用位置全局同形禁着与中国数子法。双方连续停一手后自动按当前盘面计分，死子不会自动判定；如有争议请撤销上一回合或重新开始。</p>
            )}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <p>所有棋规、计分与电脑着法均在你的设备上执行。</p>
        <p>围棋 · 中国象棋 · 浏览器本地对弈</p>
      </footer>
    </div>
  );
}

export default App;
